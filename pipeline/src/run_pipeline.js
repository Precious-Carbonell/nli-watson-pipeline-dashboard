/**
 * ============================================================================
 * MAIN ORCHESTRATOR: NLI Data Pipeline
 * ============================================================================
 *
 * Runs the full pipeline in sequence:
 *   Step 1 — Data Quality Assessment & Diagnostics (01_diagnostics.js)
 *   Step 2 — Cleaning & Integrity Enforcement    (02_clean.js)
 *   Step 3 — Export & Post-Quality Validation    (03_export.js)
 *
 * Usage:
 *   node src/run_pipeline.js          # Run full pipeline (all steps)
 *   node src/run_pipeline.js --step 1 # Run only diagnostics
 *   node src/run_pipeline.js --step 2 # Run only cleaning
 *   node src/run_pipeline.js --step 3 # Run only export
 *
 * The pipeline is idempotent — each run rebuilds from raw CSV sources.
 * Step 3 is the authoritative output step that produces the final Parquet files.
 * ============================================================================
 */

const { execSync } = require('child_process');
const path = require('path');

const SCRIPTS = {
  1: { file: '01_diagnostics.js', label: 'Data Quality Assessment & Diagnostics' },
  2: { file: '02_clean.js',       label: 'Cleaning & Integrity Enforcement' },
  3: { file: '03_export.js',      label: 'Export & Post-Quality Validation' },
};

function banner(step, label) {
  const line = '═'.repeat(70);
  console.log(`\n${line}`);
  console.log(`  STEP ${step}: ${label}`);
  console.log(`${line}\n`);
}

function runStep(stepNum) {
  const { file, label } = SCRIPTS[stepNum];
  banner(stepNum, label);

  const scriptPath = path.join(__dirname, file);
  const startTime = Date.now();

  try {
    execSync(`node "${scriptPath}"`, {
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '..'),
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n  ⏱  Step ${stepNum} completed in ${elapsed}s`);
  } catch (err) {
    console.error(`\n  ✗ Step ${stepNum} failed with exit code ${err.status}`);
    process.exit(err.status || 1);
  }
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const stepFlagIdx = args.indexOf('--step');
let stepsToRun = [1, 2, 3]; // default: all

if (stepFlagIdx !== -1) {
  const stepVal = parseInt(args[stepFlagIdx + 1], 10);
  if (!SCRIPTS[stepVal]) {
    console.error(`Invalid step: ${stepVal}. Valid steps: 1, 2, 3`);
    process.exit(1);
  }
  stepsToRun = [stepVal];
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------
console.log('╔══════════════════════════════════════════════════════════════════════╗');
console.log('║        NLI WATSON PIPELINE — Data Processing & Validation          ║');
console.log('╚══════════════════════════════════════════════════════════════════════╝');
console.log(`\n  Steps to run: ${stepsToRun.join(', ')}`);
console.log(`  Working dir:  ${path.resolve(__dirname, '..')}`);

const pipelineStart = Date.now();

for (const step of stepsToRun) {
  runStep(step);
}

const totalElapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);
console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
console.log(`║  ✓ PIPELINE COMPLETE — Total time: ${totalElapsed}s`);
console.log('╚══════════════════════════════════════════════════════════════════════╝\n');
