/**
 * React hook for DuckDB-WASM initialization.
 * 
 * Provides loading state, error handling, and data availability flags
 * to the component tree. Components wait for this before issuing queries.
 *
 * INSIGHT: We separate initialization from querying so the app can show
 * a loading skeleton while WASM boots (~200ms), then immediately begin
 * issuing SQL once the Parquet files are registered in the VFS.
 */

import { useState, useEffect } from 'react';
import { initDuckDB } from '../lib/duckdb';
import type { DataAvailability } from '../lib/duckdb';

type DuckDBState = {
  ready: boolean;
  loading: boolean;
  error: string | null;
  availability: DataAvailability;
};

export function useDuckDB(): DuckDBState {
  const [state, setState] = useState<DuckDBState>({
    ready: false,
    loading: true,
    error: null,
    availability: { train: false, test: false, trainingLog: false, valPredictions: false },
  });

  useEffect(() => {
    let cancelled = false;

    initDuckDB()
      .then(({ availability }) => {
        if (!cancelled) {
          setState({ ready: true, loading: false, error: null, availability });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Unknown DuckDB initialization error';
          setState((prev) => ({ ...prev, loading: false, error: message }));
        }
      });

    return () => { cancelled = true; };
  }, []);

  return state;
}
