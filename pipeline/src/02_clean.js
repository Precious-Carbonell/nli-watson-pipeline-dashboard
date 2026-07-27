/**
 * ============================================================================
 * STEP 2: CLEANING & INTEGRITY ENFORCEMENT
 * ============================================================================
 *
 * Operations performed:
 *   1. Flag (not drop) rows with missing premise/hypothesis/label in train.csv
 *   2. Assert test.csv has zero nulls in premise/hypothesis
 *   3. TRIM() whitespace on all text columns
 *   4. Normalize inconsistent lang_abv/language pairings to canonical mapping
 *   5. Add derived columns: premise_word_count, premise_char_count,
 *      hypothesis_word_count, hypothesis_char_count
 *   6. Deduplicate exact (premise, hypothesis, label) via QUALIFY ROW_NUMBER()
 *   7. Flag (don't auto-resolve) pairs with same premise+hypothesis but
 *      conflicting labels — written to a separate flagged_conflicts table
 *
 * WHY SERVER-SIDE DUCKDB:
 *   DuckDB's SQL window functions (ROW_NUMBER, PARTITION BY) handle deduplication
 *   in a single streaming pass without materializing intermediate hash maps in JS.
 *   The browser's DuckDB-WASM instance then only loads the already-deduplicated,
 *   validated Parquet — no wasted bandwidth or client-side compute on dirty rows.
 * ============================================================================
 */

const duckdb = require('duckdb');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const TRAIN_CSV = path.join(PROJECT_ROOT, 'data', 'train.csv').replace(/\\/g, '/');
const TEST_CSV = path.join(PROJECT_ROOT, 'data', 'test.csv').replace(/\\/g, '/');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'data', 'processed');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

/**
 * Run a SQL query and return all result rows.
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
 * Execute a SQL statement (no result needed).
 */
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

async function runCleaning() {
  const db = new duckdb.Database(':memory:');

  // -------------------------------------------------------------------------
  // Load raw data
  // -------------------------------------------------------------------------
  await exec(db, `
    CREATE TABLE train_raw AS
    SELECT * FROM read_csv_auto('${TRAIN_CSV}', header=true, all_varchar=false);
  `);

  await exec(db, `
    CREATE TABLE test_raw AS
    SELECT * FROM read_csv_auto('${TEST_CSV}', header=true, all_varchar=false);
  `);

  // =========================================================================
  // 1. FLAG ROWS WITH MISSING VALUES (train.csv)
  // =========================================================================
  section('1. FLAGGING ROWS WITH MISSING VALUES (train.csv)');

  // Create a flagged table for rows with quality issues
  await exec(db, `
    CREATE TABLE train_flagged_missing AS
    SELECT *, 
      CASE
        WHEN premise IS NULL OR TRIM(premise) = '' THEN 'missing_premise'
        WHEN hypothesis IS NULL OR TRIM(hypothesis) = '' THEN 'missing_hypothesis'
        WHEN label IS NULL THEN 'missing_label'
      END AS flag_reason
    FROM train_raw
    WHERE premise IS NULL OR TRIM(premise) = ''
       OR hypothesis IS NULL OR TRIM(hypothesis) = ''
       OR label IS NULL;
  `);

  const flaggedCount = await query(db, `SELECT COUNT(*) AS cnt FROM train_flagged_missing;`);
  console.log(`  Flagged rows with missing values: ${flaggedCount[0].cnt}`);

  if (flaggedCount[0].cnt > 0) {
    const flaggedSample = await query(db, `
      SELECT id, flag_reason, LEFT(premise, 40) AS premise_preview 
      FROM train_flagged_missing LIMIT 10;
    `);
    console.table(flaggedSample);
  }

  // =========================================================================
  // 2. ASSERT test.csv HAS ZERO NULLS IN premise/hypothesis
  // =========================================================================
  section('2. ASSERT: test.csv has zero nulls in premise/hypothesis');

  const testNulls = await query(db, `
    SELECT COUNT(*) AS null_count
    FROM test_raw
    WHERE premise IS NULL OR TRIM(premise) = ''
       OR hypothesis IS NULL OR TRIM(hypothesis) = '';
  `);

  if (testNulls[0].null_count > 0) {
    throw new Error(
      `ASSERTION FAILED: test.csv has ${testNulls[0].null_count} rows with null/empty premise or hypothesis.`
    );
  }
  console.log('  ✓ test.csv assertion passed: zero nulls in premise/hypothesis.');

  // =========================================================================
  // 3. TRIM WHITESPACE + 4. NORMALIZE lang_abv/language PAIRINGS
  // =========================================================================
  section('3-4. TRIM WHITESPACE & NORMALIZE LANGUAGE PAIRINGS');

  // Build canonical mapping from the most frequent (lang_abv → language) pair
  // across both datasets combined for consistency
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
    FROM ranked
    WHERE rn = 1;
  `);

  const canonicalMap = await query(db, `SELECT * FROM canonical_lang ORDER BY lang_abv;`);
  console.log('  Canonical lang_abv → language mapping:');
  console.table(canonicalMap);

  // Apply TRIM + normalize language using canonical mapping for TRAIN
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
    -- Exclude rows flagged for missing values (they are preserved separately)
    WHERE t.premise IS NOT NULL AND TRIM(t.premise) != ''
      AND t.hypothesis IS NOT NULL AND TRIM(t.hypothesis) != ''
      AND t.label IS NOT NULL;
  `);

  // Apply TRIM + normalize language using canonical mapping for TEST
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

  const trainTrimCount = await query(db, `SELECT COUNT(*) AS cnt FROM train_trimmed;`);
  const testTrimCount = await query(db, `SELECT COUNT(*) AS cnt FROM test_trimmed;`);
  console.log(`\n  After trim+normalize — train: ${trainTrimCount[0].cnt} rows, test: ${testTrimCount[0].cnt} rows`);

  // =========================================================================
  // 5. ADD DERIVED COLUMNS: premise_length, hypothesis_length (word + char)
  // =========================================================================
  section('5. ADD DERIVED COLUMNS (word & char counts)');

  // Train: add word count (split by spaces) and char count
  await exec(db, `
    CREATE TABLE train_enriched AS
    SELECT
      *,
      -- Character counts (LENGTH of trimmed text)
      LENGTH(premise)    AS premise_char_count,
      LENGTH(hypothesis) AS hypothesis_char_count,
      -- Word counts (number of space-separated tokens; handles multi-space via regexp)
      CASE 
        WHEN premise = '' THEN 0
        ELSE array_length(regexp_split_to_array(premise, '\\s+'))
      END AS premise_word_count,
      CASE 
        WHEN hypothesis = '' THEN 0
        ELSE array_length(regexp_split_to_array(hypothesis, '\\s+'))
      END AS hypothesis_word_count
    FROM train_trimmed;
  `);

  // Test: same derived columns
  await exec(db, `
    CREATE TABLE test_enriched AS
    SELECT
      *,
      LENGTH(premise)    AS premise_char_count,
      LENGTH(hypothesis) AS hypothesis_char_count,
      CASE 
        WHEN premise = '' THEN 0
        ELSE array_length(regexp_split_to_array(premise, '\\s+'))
      END AS premise_word_count,
      CASE 
        WHEN hypothesis = '' THEN 0
        ELSE array_length(regexp_split_to_array(hypothesis, '\\s+'))
      END AS hypothesis_word_count
    FROM test_trimmed;
  `);

  // Show sample of derived columns
  const derivedSample = await query(db, `
    SELECT id, premise_word_count, premise_char_count, 
           hypothesis_word_count, hypothesis_char_count
    FROM train_enriched LIMIT 5;
  `);
  console.log('  Sample derived columns (train):');
  console.table(derivedSample);

  // =========================================================================
  // 6. DEDUPLICATE EXACT (premise, hypothesis, label) VIA QUALIFY ROW_NUMBER()
  // =========================================================================
  section('6. DEDUPLICATE EXACT (premise, hypothesis, label) ROWS');

  const preDedup = await query(db, `SELECT COUNT(*) AS cnt FROM train_enriched;`);

  await exec(db, `
    CREATE TABLE train_deduped AS
    SELECT *
    FROM train_enriched
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY premise, hypothesis, label
      ORDER BY id
    ) = 1;
  `);

  const postDedup = await query(db, `SELECT COUNT(*) AS cnt FROM train_deduped;`);
  const removed = preDedup[0].cnt - postDedup[0].cnt;
  console.log(`  Before dedup: ${preDedup[0].cnt} → After dedup: ${postDedup[0].cnt}`);
  console.log(`  Exact duplicate rows removed: ${removed}`);

  // Test deduplication (no label, so partition by premise+hypothesis only)
  const preDedupTest = await query(db, `SELECT COUNT(*) AS cnt FROM test_enriched;`);

  await exec(db, `
    CREATE TABLE test_deduped AS
    SELECT *
    FROM test_enriched
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY premise, hypothesis
      ORDER BY id
    ) = 1;
  `);

  const postDedupTest = await query(db, `SELECT COUNT(*) AS cnt FROM test_deduped;`);
  const removedTest = preDedupTest[0].cnt - postDedupTest[0].cnt;
  console.log(`  test.csv — Before: ${preDedupTest[0].cnt} → After: ${postDedupTest[0].cnt} (removed ${removedTest})`);

  // =========================================================================
  // 7. FLAG CONFLICTING LABELS (same premise+hypothesis, different labels)
  // =========================================================================
  section('7. FLAG CONFLICTING LABELS (not auto-resolved)');

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
      ON t.premise = c.premise AND t.hypothesis = c.hypothesis
    ORDER BY t.premise, t.label;
  `);

  const conflictCount = await query(db, `SELECT COUNT(*) AS cnt FROM flagged_conflicts;`);
  const conflictGroups = await query(db, `
    SELECT COUNT(DISTINCT premise || '|||' || hypothesis) AS groups FROM flagged_conflicts;
  `);
  console.log(`  Conflicting label rows flagged: ${conflictCount[0].cnt} (in ${conflictGroups[0].groups} groups)`);

  if (conflictCount[0].cnt > 0) {
    const conflictSample = await query(db, `
      SELECT id, LEFT(premise, 50) AS premise_preview, label
      FROM flagged_conflicts LIMIT 10;
    `);
    console.log('  [Sample conflicting rows — require manual review]:');
    console.table(conflictSample);
  }

  // Remove conflicting rows from the clean dataset (they're preserved in flagged_conflicts)
  await exec(db, `
    CREATE TABLE train_clean AS
    SELECT t.*
    FROM train_deduped t
    WHERE NOT EXISTS (
      SELECT 1 FROM flagged_conflicts f
      WHERE f.id = t.id
    );
  `);

  // Final clean test table (rename for consistency)
  await exec(db, `
    CREATE TABLE test_clean AS SELECT * FROM test_deduped;
  `);

  const finalTrainCount = await query(db, `SELECT COUNT(*) AS cnt FROM train_clean;`);
  const finalTestCount = await query(db, `SELECT COUNT(*) AS cnt FROM test_clean;`);

  section('CLEANING SUMMARY');
  console.log(`  train_clean:       ${finalTrainCount[0].cnt} rows (ready for export)`);
  console.log(`  test_clean:        ${finalTestCount[0].cnt} rows (ready for export)`);
  console.log(`  flagged_missing:   ${flaggedCount[0].cnt} rows (needs review)`);
  console.log(`  flagged_conflicts: ${conflictCount[0].cnt} rows (needs review)`);

  console.log('\n✓ Cleaning complete. Tables ready for Step 3 (export).\n');

  // Close database
  db.close();

  // Return stats for orchestrator
  return {
    trainClean: finalTrainCount[0].cnt,
    testClean: finalTestCount[0].cnt,
    flaggedMissing: flaggedCount[0].cnt,
    flaggedConflicts: conflictCount[0].cnt,
    duplicatesRemoved: removed,
  };
}

module.exports = { runCleaning };

// Run standalone
if (require.main === module) {
  runCleaning().catch((err) => {
    console.error('Cleaning failed:', err);
    process.exit(1);
  });
}
