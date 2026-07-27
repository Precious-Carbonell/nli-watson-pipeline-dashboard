/**
 * Hook to fetch the list of available languages from the train dataset.
 * Used to populate the global language filter dropdown.
 */

import { useQuery } from './useQuery';

type LangRow = { language: string };

export function useLanguages() {
  const { data, loading } = useQuery<LangRow>(
    `SELECT DISTINCT language FROM train ORDER BY language`
  );
  return { languages: data.map((r) => r.language), loading };
}
