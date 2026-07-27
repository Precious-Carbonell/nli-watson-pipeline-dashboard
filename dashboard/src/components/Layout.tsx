/**
 * Layout Shell — Header with tabs and global language filter.
 *
 * INSIGHT: The tab bar and language dropdown live in the fixed header so users
 * always have navigation context. The filter re-renders only the active tab's
 * queries, not the entire page, because it updates context state that each
 * tab subscribes to independently via useAppContext.
 */

import { useAppContext } from '../context/AppContext';
import { useLanguages } from '../hooks/useLanguages';
import type { TabId } from '../context/AppContext';
import type { ReactNode } from 'react';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'painpoint', label: 'Pain Point' },
  { id: 'trends', label: 'Trends' },
  { id: 'details', label: 'Details' },
];

type LayoutProps = { children: ReactNode };

export function Layout({ children }: LayoutProps) {
  const { activeTab, setActiveTab, languageFilter, setLanguageFilter } = useAppContext();
  const { languages } = useLanguages();

  return (
    <>
      <header className="app-header">
        <h1>NLI Watson - Multilingual Analysis Dashboard</h1>
        <div className="header-controls">
          <nav className="tab-bar" role="tablist" aria-label="Dashboard sections">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={activeTab === tab.id}
                className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          <div className="language-filter">
            <label htmlFor="lang-select">Language:</label>
            <select
              id="lang-select"
              value={languageFilter}
              onChange={(e) => setLanguageFilter(e.target.value)}
            >
              <option value="">All Languages</option>
              {languages.map((lang) => (
                <option key={lang} value={lang}>{lang}</option>
              ))}
            </select>
          </div>
        </div>
      </header>

      <main className="app-main" role="tabpanel">
        {children}
      </main>
    </>
  );
}
