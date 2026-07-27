/**
 * ============================================================================
 * STEP 1: DATA QUALITY ASSESSMENT & DIAGNOSTICS
 * ============================================================================
 * 
 * Audits the raw CSVs for:
 *   - Column missingness (NULL / empty strings in premise, hypothesis, label)
 *   - Schema types and column metadata
 *   - Per-language row counts
 *   - Label distribution per language (train only)
 *   - Duplicate (premise, hypothesis) rows
 *   - Mismatched lang_abv / language pairs
 * 
 * WHY SERVER-SIDE DUCKDB:
 *   DuckDB processes the full CSV scan in a single pass using columnar 
 *   vectorized execution, keeping memory usage constant regardless of row count.
 *   This means the browser never has to parse raw CSV — it receives only the
 *   compact, pre-validated Parquet output downstream.
 * ============================================================================
 */

const duckdb = require('duckdb');
const path = require('path');

// Resolve paths relative to project root (pipeline lives one level down)
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const TRAIN_CSV = path.join(PROJECT_ROOT, 'data', 'train.csv');
const TEST_CSV = path.join(PROJECT_ROOT, 'data', 'test.csv');

/**
 * Run a SQL query and return all result rows as an array of objects.
 */
function query(db, sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

/**
 * Print a labeled section header for readability in console output.
 */
function section(title) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${'='.repeat(70)}`);
}

async function runDiagnostics() {
  const db = new duckdb.Database(':memory:');

  // -------------------------------------------------------------------------
  // Load CSVs into DuckDB views for zero-copy querying
  // -------------------------------------------------------------------------
  await query(db, `
    CREATE VIEW train_raw AS
    SELECT * FROM read_csv_auto('${TRAIN_CSV.replace(/\\/g, '/')}', header=true, all_varchar=false);
  `);

  await query(db, `
    CREATE VIEW test_raw AS
    SELECT * FROM read_csv_auto('${TEST_CSV.replace(/\\/g, '/')}', header=true, all_varchar=false);
  `);

  // =========================================================================
  // 1. SCHEMA & COLUMN TYPES
  // =========================================================================
  section('1. SCHEMA & COLUMN TYPES');

  const trainSchema = await query(db, `DESCRIBE SELECT * FROM train_raw;`);
  console.log('\n[train.csv schema]');
  console.table(trainSchema);

  const testSchema = await query(db, `DESCRIBE SELECT * FROM test_raw;`);
  console.log('\n[test.csv schema]');
  console.table(testSchema);

  // =========================================================================
  // 2. ROW COUNTS
  // =========================================================================
  section('2. TOTAL ROW COUNTS');

  const trainCount = await query(db, `SELECT COUNT(*) AS total_rows FROM train_raw;`);
  const testCount = await query(db, `SELECT COUNT(*) AS total_rows FROM test_raw;`);
  console.log(`  train.csv: ${trainCount[0].total_rows} rows`);
  console.log(`  test.csv:  ${testCount[0].total_rows} rows`);

  // =========================================================================
  // 3. COLUMN MISSINGNESS (NULLs + empty strings)
  // =========================================================================
  section('3. COLUMN MISSINGNESS');

  console.log('\n[train.csv — null or empty counts]');
  const trainMissing = await query(db, `
    SELECT
      COUNT(*) FILTER (WHERE premise IS NULL OR TRIM(premise) = '')       AS premise_missing,
      COUNT(*) FILTER (WHERE hypothesis IS NULL OR TRIM(hypothesis) = '') AS hypothesis_missing,
      COUNT(*) FILTER (WHERE label IS NULL)                               AS label_missing,
      COUNT(*) FILTER (WHERE lang_abv IS NULL OR TRIM(lang_abv) = '')    AS lang_abv_missing,
      COUNT(*) FILTER (WHERE language IS NULL OR TRIM(language) = '')     AS language_missing
    FROM train_raw;
  `);
  console.table(trainMissing);

  console.log('[test.csv — null or empty counts]');
  const testMissing = await query(db, `
    SELECT
      COUNT(*) FILTER (WHERE premise IS NULL OR TRIM(premise) = '')       AS premise_missing,
      COUNT(*) FILTER (WHERE hypothesis IS NULL OR TRIM(hypothesis) = '') AS hypothesis_missing,
      COUNT(*) FILTER (WHERE lang_abv IS NULL OR TRIM(lang_abv) = '')    AS lang_abv_missing,
      COUNT(*) FILTER (WHERE language IS NULL OR TRIM(language) = '')     AS language_missing
    FROM test_raw;
  `);
  console.table(testMissing);

  // =========================================================================
  // 4. LABEL VALUES OUTSIDE {0, 1, 2} (train only)
  // =========================================================================
  section('4. INVALID LABEL VALUES (train.csv)');

  const invalidLabels = await query(db, `
    SELECT label, COUNT(*) AS occurrences
    FROM train_raw
    WHERE label NOT IN (0, 1, 2)
    GROUP BY label
    ORDER BY occurrences DESC;
  `);
  if (invalidLabels.length === 0) {
    console.log('  ✓ All label values are within {0, 1, 2}.');
  } else {
    console.log('  ✗ Found invalid label values:');
    console.table(invalidLabels);
  }

  // =========================================================================
  // 5. PER-LANGUAGE ROW COUNTS
  // =========================================================================
  section('5. PER-LANGUAGE ROW COUNTS');

  console.log('\n[train.csv]');
  const trainLangCounts = await query(db, `
    SELECT lang_abv, language, COUNT(*) AS row_count
    FROM train_raw
    GROUP BY lang_abv, language
    ORDER BY row_count DESC;
  `);
  console.table(trainLangCounts);

  console.log('[test.csv]');
  const testLangCounts = await query(db, `
    SELECT lang_abv, language, COUNT(*) AS row_count
    FROM test_raw
    GROUP BY lang_abv, language
    ORDER BY row_count DESC;
  `);
  console.table(testLangCounts);

  // =========================================================================
  // 6. LABEL DISTRIBUTION PER LANGUAGE (train only)
  // =========================================================================
  section('6. LABEL DISTRIBUTION PER LANGUAGE (train.csv)');

  const labelDist = await query(db, `
    SELECT
      language,
      COUNT(*) FILTER (WHERE label = 0) AS entailment,
      COUNT(*) FILTER (WHERE label = 1) AS neutral,
      COUNT(*) FILTER (WHERE label = 2) AS contradiction,
      COUNT(*)                           AS total
    FROM train_raw
    GROUP BY language
    ORDER BY total DESC;
  `);
  console.table(labelDist);

  // =========================================================================
  // 7. MISMATCHED lang_abv / language PAIRS
  // =========================================================================
  section('7. MISMATCHED lang_abv / language PAIRS');

  // Build a reference mapping from the most frequent pairing
  const mismatchTrain = await query(db, `
    WITH canonical AS (
      -- The most frequent (lang_abv, language) pair defines the "correct" mapping
      SELECT lang_abv, language, COUNT(*) AS n,
             ROW_NUMBER() OVER (PARTITION BY lang_abv ORDER BY COUNT(*) DESC) AS rn
      FROM train_raw
      GROUP BY lang_abv, language
    ),
    ref AS (
      SELECT lang_abv, language AS canonical_language FROM canonical WHERE rn = 1
    )
    SELECT t.id, t.lang_abv, t.language AS actual_language, r.canonical_language
    FROM train_raw t
    JOIN ref r ON t.lang_abv = r.lang_abv
    WHERE t.language != r.canonical_language
    LIMIT 20;
  `);

  if (mismatchTrain.length === 0) {
    console.log('  ✓ All lang_abv / language pairs are consistent in train.csv.');
  } else {
    console.log(`  ✗ Found mismatched pairs in train.csv (showing up to 20):`);
    console.table(mismatchTrain);
  }

  const mismatchTest = await query(db, `
    WITH canonical AS (
      SELECT lang_abv, language, COUNT(*) AS n,
             ROW_NUMBER() OVER (PARTITION BY lang_abv ORDER BY COUNT(*) DESC) AS rn
      FROM test_raw
      GROUP BY lang_abv, language
    ),
    ref AS (
      SELECT lang_abv, language AS canonical_language FROM canonical WHERE rn = 1
    )
    SELECT t.id, t.lang_abv, t.language AS actual_language, r.canonical_language
    FROM test_raw t
    JOIN ref r ON t.lang_abv = r.lang_abv
    WHERE t.language != r.canonical_language
    LIMIT 20;
  `);

  if (mismatchTest.length === 0) {
    console.log('  ✓ All lang_abv / language pairs are consistent in test.csv.');
  } else {
    console.log(`  ✗ Found mismatched pairs in test.csv (showing up to 20):`);
    console.table(mismatchTest);
  }

  // =========================================================================
  // 8. DUPLICATE (premise, hypothesis) ROWS
  // =========================================================================
  section('8. DUPLICATE (premise, hypothesis) ROWS');

  const trainDupes = await query(db, `
    SELECT COUNT(*) AS duplicate_row_count
    FROM (
      SELECT premise, hypothesis,
             ROW_NUMBER() OVER (PARTITION BY premise, hypothesis ORDER BY id) AS rn
      FROM train_raw
    )
    WHERE rn > 1;
  `);
  console.log(`  train.csv duplicate (premise, hypothesis) rows: ${trainDupes[0].duplicate_row_count}`);

  const testDupes = await query(db, `
    SELECT COUNT(*) AS duplicate_row_count
    FROM (
      SELECT premise, hypothesis,
             ROW_NUMBER() OVER (PARTITION BY premise, hypothesis ORDER BY id) AS rn
      FROM test_raw
    )
    WHERE rn > 1;
  `);
  console.log(`  test.csv duplicate (premise, hypothesis) rows: ${testDupes[0].duplicate_row_count}`);

  // Show a sample of duplicates from train
  const trainDupeSample = await query(db, `
    WITH dupes AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY premise, hypothesis ORDER BY id) AS rn
      FROM train_raw
    )
    SELECT id, LEFT(premise, 60) AS premise_preview, LEFT(hypothesis, 60) AS hypothesis_preview, label, rn
    FROM dupes
    WHERE rn > 1
    LIMIT 10;
  `);
  if (trainDupeSample.length > 0) {
    console.log('\n  [Sample duplicate rows from train.csv]');
    console.table(trainDupeSample);
  }

  // =========================================================================
  // 9. CONFLICTING LABELS (same premise+hypothesis, different labels)
  // =========================================================================
  section('9. CONFLICTING LABELS (same premise+hypothesis, different label)');

  const conflicts = await query(db, `
    WITH grouped AS (
      SELECT premise, hypothesis, COUNT(DISTINCT label) AS label_count
      FROM train_raw
      GROUP BY premise, hypothesis
      HAVING COUNT(DISTINCT label) > 1
    )
    SELECT
      g.premise, g.hypothesis, g.label_count,
      t.label, t.id
    FROM grouped g
    JOIN train_raw t ON t.premise = g.premise AND t.hypothesis = g.hypothesis
    ORDER BY g.premise, t.label
    LIMIT 20;
  `);

  if (conflicts.length === 0) {
    console.log('  ✓ No conflicting labels found for identical (premise, hypothesis) pairs.');
  } else {
    console.log(`  ✗ Found conflicting labels (showing up to 20 rows):`);
    console.table(conflicts);
  }

  console.log('\n\n✓ Diagnostics complete.\n');

  // Close the database
  db.close();
}

// Run
runDiagnostics().catch((err) => {
  console.error('Diagnostics failed:', err);
  process.exit(1);
});
