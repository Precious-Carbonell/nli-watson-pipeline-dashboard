/**
 * React hook for executing SQL queries against DuckDB-WASM.
 * 
 * Features:
 * - Automatic re-execution when SQL or dependencies change
 * - Performance timing logged to console (performance audit)
 * - Returns loading/error/data state for UI consumption
 *
 * INSIGHT: Each query is tied to a dependency array (like useEffect) so
 * when the global language filter changes, only the active tab's queries
 * re-execute — keeping the UI responsive without a full re-render storm.
 */

import { useState, useEffect, useCallback } from 'react';
import { queryDuckDB } from '../lib/duckdb';

type QueryState<T> = {
  data: T[];
  loading: boolean;
  error: string | null;
  queryTimeMs: number | null;
};

export function useQuery<T = Record<string, unknown>>(
  sql: string | null,
  deps: unknown[] = []
): QueryState<T> & { refetch: () => void } {
  const [state, setState] = useState<QueryState<T>>({
    data: [],
    loading: false,
    error: null,
    queryTimeMs: null,
  });

  const execute = useCallback(async () => {
    if (!sql) return;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const { rows, queryTimeMs } = await queryDuckDB<T>(sql);
      setState({ data: rows, loading: false, error: null, queryTimeMs });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Query failed';
      setState((prev) => ({ ...prev, loading: false, error: message }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sql, ...deps]);

  useEffect(() => {
    execute();
  }, [execute]);

  return { ...state, refetch: execute };
}
