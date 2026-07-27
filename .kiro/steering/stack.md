# Project Stack & Conventions

## Overview
This project processes the Kaggle "Contradictory, My Dear Watson" multilingual
NLI dataset (premise, hypothesis, label, language) and visualizes it.

## Pipeline (/pipeline)
- Node.js + DuckDB (server-side, in-process SQL)
- Reads raw CSVs from /data
- Cleans, validates, deduplicates, adds derived columns (premise_length,
  hypothesis_length) via SQL
- Outputs Parquet files (SNAPPY compression) to /data/processed

## Dashboard (/dashboard)
- Vite + React + TypeScript
- DuckDB-WASM for client-side querying of the processed Parquet files
- Recharts for visualizations
- No backend server — everything runs in-browser

## Conventions
- SQL lives in .sql files or clearly commented template strings, not buried
  in JS logic
- Every pipeline step ends with an assertion/validation query
- Parquet is the hand-off contract between pipeline and dashboard — schema
  changes must be reflected in both