/**
 * ============================================================================
 * STEP 3: EXPORT & POST-QUALITY VALIDATION
 * ============================================================================
 *
 * This script performs the full clean pipeline (reuses Step 2 logic in-process)
 * then:
 *   1. Asserts label values are only {0,1,2} in train_clean
 *   2. Asserts no nulls in premise/hypothesis across both datasets
 *   3. Reports row count changes with explanations
 *   4. Exports to Parquet with SNAPPY compression
 *   5. Validates the exported Parquet files by re-reading them
 *
 * WHY SERVER-SIDE DUCKDB:
 *   DuckDB's COPY ... TO ... (FORMAT PARQUET, CODEC 'SNAPPY') writes columnar
 *   Parquet directly from its in-memory buffer pool — no serialization through
 *   JS objects. The resulting files are optimally compressed for DuckDB-WASM to
 *   memory-map and query with zero deserialization cost on the client side.
 * ============================================================================
 */

const duckdb = require('duckdb');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const TRAIN_CSV = path.join(PROJECT_ROOT, 'data', 'train.csv').replace(/\\/g, '/');
const TEST_CSV = path.join(PROJECT_ROOT, 'data', 'test.csv').replace(/\\/g, '/');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'data', 'processed').replace(/\\/g, '/');
const TRAIN_PARQUET = `${OUTPUT_DIR}/train_cleaned.parquet`;
const TEST_PARQUET = `${OUTPUT_DIR}/test_cleaned.parquet`;

// Ensure output directory exists
if (!fs.existsSync(path.join(PROJECT_ROOT, 'data', 'processed'))) {
  fs.mkdirSync(path.join(PROJECT_ROOT, 'data', 'processed'), { recursive: true });
}

function query(db, sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function exec(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function section(title) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${'='.repeat(70)}`);
}

async function runExport() {
  const db = new duckdb.Database(':memory:');

  // -------------------------------------------------------------------------
  // Reproduce the cleaning pipeline in one database session
  // (Steps are idempotent — we rebuild from raw CSV each run)
  // -------------------------------------------------------------------------
  section('LOADING & CLEANING (reproducing Step 2 in-process)');

  // Load raw
  await exec(db, `
    CREATE TABLE train_raw AS
    SELECT * FROM read_csv_auto('${TRAIN_CSV}', header=true, all_varchar=false);
  `);
  await exec(db, `
    CREATE TABLE test_raw AS
    SELECT * FROM read_csv_auto('${TEST_CSV}', header=true, all_varchar=false);
  `);

  const rawTrainCount = await query(db, `SELECT COUNT(*) AS cnt FROM train_raw;`);
  const rawTestCount = await query(db, `SELECT COUNT(*) AS cnt FROM test_raw;`);
  console.log(`  Raw train rows: ${rawTrainCount[0].cnt}`);
  console.log(`  Raw test rows:  ${rawTestCount[0].cnt}`);

  // Canonical language mapping
  await exec(db, `
    CREATE TABLE canonical_lang AS
    WITH combined AS (
      SELECT lang_abv, language FROM train_raw
      UNION ALL
      SELECT lang_abv, language FROM test_raw
    ),
    ranked AS (
      SELECT lang_abv, language, COUNT(*) AS n,
             ROW_NUMBER() OVER (PARTITION BY lang_abv ORDER BY COUNT(*) DESC) AS rn
      FROM combined
      GROUP BY lang_abv, language
    )
    SELECT lang_abv, language AS canonical_language
    FROM ranked WHERE rn = 1;
  `);

  // Trim + normalize + filter missing (train)
  await exec(db, `
    CREATE TABLE train_trimmed AS
    SELECT
      t.id,
      TRIM(t.premise)    AS premise,
      TRIM(t.hypothesis) AS hypothesis,
      TRIM(t.lang_abv)   AS lang_abv,
      c.canonical_language AS language,
      t.label
    FROM train_raw t
    LEFT JOIN canonical_lang c ON TRIM(t.lang_abv) = c.lang_abv
    WHERE t.premise IS NOT NULL AND TRIM(t.premise) != ''
      AND t.hypothesis IS NOT NULL AND TRIM(t.hypothesis) != ''
      AND t.label IS NOT NULL;
  `);

  // Trim + normalize (test)
  await exec(db, `
    CREATE TABLE test_trimmed AS
    SELECT
      t.id,
      TRIM(t.premise)    AS premise,
      TRIM(t.hypothesis) AS hypothesis,
      TRIM(t.lang_abv)   AS lang_abv,
      c.canonical_language AS language
    FROM test_raw t
    LEFT JOIN canonical_lang c ON TRIM(t.lang_abv) = c.lang_abv;
  `);

  // Enrich with derived columns
  await exec(db, `
    CREATE TABLE train_enriched AS
    SELECT *,
      LENGTH(premise)    AS premise_char_count,
      LENGTH(hypothesis) AS hypothesis_char_count,
      CASE WHEN premise = '' THEN 0
           ELSE array_length(regexp_split_to_array(premise, '\\s+'))
      END AS premise_word_count,
      CASE WHEN hypothesis = '' THEN 0
           ELSE array_length(regexp_split_to_array(hypothesis, '\\s+'))
      END AS hypothesis_word_count
    FROM train_trimmed;
  `);

  await exec(db, `
    CREATE TABLE test_enriched AS
    SELECT *,
      LENGTH(premise)    AS premise_char_count,
      LENGTH(hypothesis) AS hypothesis_char_count,
      CASE WHEN premise = '' THEN 0
           ELSE array_length(regexp_split_to_array(premise, '\\s+'))
      END AS premise_word_count,
      CASE WHEN hypothesis = '' THEN 0
           ELSE array_length(regexp_split_to_array(hypothesis, '\\s+'))
      END AS hypothesis_word_count
    FROM test_trimmed;
  `);

  // Deduplicate train (exact premise+hypothesis+label)
  await exec(db, `
    CREATE TABLE train_deduped AS
    SELECT * FROM train_enriched
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY premise, hypothesis, label ORDER BY id
    ) = 1;
  `);

  // Deduplicate test (premise+hypothesis)
  await exec(db, `
    CREATE TABLE test_deduped AS
    SELECT * FROM test_enriched
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY premise, hypothesis ORDER BY id
    ) = 1;
  `);

  // Remove conflicting-label rows from train (flag them, don't resolve)
  await exec(db, `
    CREATE TABLE flagged_conflicts AS
    WITH conflict_groups AS (
      SELECT premise, hypothesis
      FROM train_deduped
      GROUP BY premise, hypothesis
      HAVING COUNT(DISTINCT label) > 1
    )
    SELECT t.*
    FROM train_deduped t
    INNER JOIN conflict_groups c
      ON t.premise = c.premise AND t.hypothesis = c.hypothesis;
  `);

  await exec(db, `
    CREATE TABLE train_clean AS
    SELECT t.* FROM train_deduped t
    WHERE NOT EXISTS (
      SELECT 1 FROM flagged_conflicts f WHERE f.id = t.id
    );
  `);

  await exec(db, `
    CREATE TABLE test_clean AS SELECT * FROM test_deduped;
  `);

  console.log('  ✓ Cleaning pipeline reproduced successfully.');

  // =========================================================================
  // POST-QUALITY VALIDATION ASSERTIONS
  // =========================================================================
  section('POST-QUALITY VALIDATION');

  // --- Assertion 1: Label values only {0, 1, 2} in train_clean ---
  const invalidLabels = await query(db, `
    SELECT COUNT(*) AS cnt
    FROM train_clean
    WHERE label NOT IN (0, 1, 2);
  `);
  if (invalidLabels[0].cnt > 0) {
    throw new Error(`ASSERTION FAILED: train_clean has ${invalidLabels[0].cnt} rows with label outside {0,1,2}.`);
  }
  console.log('  ✓ Assertion 1 passed: All labels in train_clean are in {0, 1, 2}.');

  // --- Assertion 2: No nulls in premise/hypothesis (both datasets) ---
  const trainNulls = await query(db, `
    SELECT COUNT(*) AS cnt FROM train_clean
    WHERE premise IS NULL OR premise = ''
       OR hypothesis IS NULL OR hypothesis = '';
  `);
  if (trainNulls[0].cnt > 0) {
    throw new Error(`ASSERTION FAILED: train_clean has ${trainNulls[0].cnt} rows with null/empty premise or hypothesis.`);
  }
  console.log('  ✓ Assertion 2a passed: No nulls in train_clean premise/hypothesis.');

  const testNulls = await query(db, `
    SELECT COUNT(*) AS cnt FROM test_clean
    WHERE premise IS NULL OR premise = ''
       OR hypothesis IS NULL OR hypothesis = '';
  `);
  if (testNulls[0].cnt > 0) {
    throw new Error(`ASSERTION FAILED: test_clean has ${testNulls[0].cnt} rows with null/empty premise or hypothesis.`);
  }
  console.log('  ✓ Assertion 2b passed: No nulls in test_clean premise/hypothesis.');

  // --- Assertion 3: Row count explanation ---
  const finalTrainCount = await query(db, `SELECT COUNT(*) AS cnt FROM train_clean;`);
  const finalTestCount = await query(db, `SELECT COUNT(*) AS cnt FROM test_clean;`);
  const flaggedMissing = await query(db, `
    SELECT COUNT(*) AS cnt FROM train_raw
    WHERE premise IS NULL OR TRIM(premise) = ''
       OR hypothesis IS NULL OR TRIM(hypothesis) = ''
       OR label IS NULL;
  `);
  const conflictCount = await query(db, `SELECT COUNT(*) AS cnt FROM flagged_conflicts;`);
  const dedupedAway = rawTrainCount[0].cnt - finalTrainCount[0].cnt - flaggedMissing[0].cnt - conflictCount[0].cnt;

  section('ROW COUNT RECONCILIATION');
  console.log(`  train.csv raw:                 ${rawTrainCount[0].cnt}`);
  console.log(`  - flagged missing:             ${flaggedMissing[0].cnt}`);
  console.log(`  - exact duplicates removed:    ${dedupedAway >= 0 ? dedupedAway : 0}`);
  console.log(`  - conflicting labels flagged:  ${conflictCount[0].cnt}`);
  console.log(`  = train_clean final:           ${finalTrainCount[0].cnt}`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  test.csv raw:                  ${rawTestCount[0].cnt}`);
  console.log(`  = test_clean final:            ${finalTestCount[0].cnt}`);

  // =========================================================================
  // EXPORT TO PARQUET (SNAPPY COMPRESSION)
  // =========================================================================
  section('EXPORT TO PARQUET (SNAPPY)');

  await exec(db, `
    COPY train_clean TO '${TRAIN_PARQUET}' (FORMAT PARQUET, CODEC 'SNAPPY');
  `);
  console.log(`  ✓ Exported: ${TRAIN_PARQUET}`);

  await exec(db, `
    COPY test_clean TO '${TEST_PARQUET}' (FORMAT PARQUET, CODEC 'SNAPPY');
  `);
  console.log(`  ✓ Exported: ${TEST_PARQUET}`);

  // =========================================================================
  // VALIDATE EXPORTED PARQUET (re-read and verify)
  // =========================================================================
  section('PARQUET VALIDATION (re-read check)');

  const trainParquetCount = await query(db, `
    SELECT COUNT(*) AS cnt FROM read_parquet('${TRAIN_PARQUET}');
  `);
  const testParquetCount = await query(db, `
    SELECT COUNT(*) AS cnt FROM read_parquet('${TEST_PARQUET}');
  `);

  if (trainParquetCount[0].cnt !== finalTrainCount[0].cnt) {
    throw new Error(`PARQUET VALIDATION FAILED: train Parquet has ${trainParquetCount[0].cnt} rows, expected ${finalTrainCount[0].cnt}.`);
  }
  if (testParquetCount[0].cnt !== finalTestCount[0].cnt) {
    throw new Error(`PARQUET VALIDATION FAILED: test Parquet has ${testParquetCount[0].cnt} rows, expected ${finalTestCount[0].cnt}.`);
  }

  console.log(`  ✓ train_cleaned.parquet: ${trainParquetCount[0].cnt} rows verified.`);
  console.log(`  ✓ test_cleaned.parquet:  ${testParquetCount[0].cnt} rows verified.`);

  // Show final schema
  const finalSchema = await query(db, `DESCRIBE SELECT * FROM read_parquet('${TRAIN_PARQUET}');`);
  console.log('\n  [Final train_cleaned.parquet schema]');
  console.table(finalSchema);

  // File sizes
  const trainSize = fs.statSync(path.join(PROJECT_ROOT, 'data', 'processed', 'train_cleaned.parquet')).size;
  const testSize = fs.statSync(path.join(PROJECT_ROOT, 'data', 'processed', 'test_cleaned.parquet')).size;
  console.log(`\n  File sizes:`);
  console.log(`    train_cleaned.parquet: ${(trainSize / 1024).toFixed(1)} KB`);
  console.log(`    test_cleaned.parquet:  ${(testSize / 1024).toFixed(1)} KB`);

  console.log('\n\n✓ Export & validation complete. Parquet files ready for DuckDB-WASM dashboard.\n');

  db.close();
}

module.exports = { runExport };

// Run standalone
if (require.main === module) {
  runExport().catch((err) => {
    console.error('Export failed:', err);
    process.exit(1);
  });
}
