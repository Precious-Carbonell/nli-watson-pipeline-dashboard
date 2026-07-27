/**
 * Global App Context
 * 
 * Provides shared state across all tabs:
 * - Active tab selection (OPTD)
 * - Global language filter (persists across tab switches)
 * - Data availability flags from DuckDB initialization
 *
 * INSIGHT: A single context avoids prop-drilling the language filter through
 * four tab components, and ensures that switching tabs preserves the user's
 * filter selection — a critical UX detail for exploratory data analysis.
 */

import { createContext, useContext, useState, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { DataAvailability } from '../lib/duckdb';

export type TabId = 'overview' | 'painpoint' | 'trends' | 'details';

type AppState = {
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
  languageFilter: string; // '' means "All Languages"
  setLanguageFilter: (lang: string) => void;
  availability: DataAvailability;
};

const AppContext = createContext<AppState | null>(null);

type AppProviderProps = {
  children: ReactNode;
  availability: DataAvailability;
};

export function AppProvider({ children, availability }: AppProviderProps) {
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [languageFilter, setLanguageFilter] = useState('');

  const value = useMemo(
    () => ({
      activeTab,
      setActiveTab,
      languageFilter,
      setLanguageFilter,
      availability,
    }),
    [activeTab, languageFilter, availability]
  );

  return <AppContext value={value}>{children}</AppContext>;
}

export function useAppContext(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppContext must be used within AppProvider');
  return ctx;
}
