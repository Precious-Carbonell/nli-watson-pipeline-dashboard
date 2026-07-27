/**
 * App Root — Wires together DuckDB initialization, context, layout, and tabs.
 *
 * INSIGHT: The app shows a loading state while DuckDB-WASM boots and Parquet
 * files are registered (~200-500ms), then renders the full OPTD layout. This
 * avoids flash-of-empty-content and ensures all child queries execute against
 * a fully-initialized database instance.
 */

import { useDuckDB } from './hooks/useDuckDB';
import { AppProvider } from './context/AppContext';
import { Layout } from './components/Layout';
import { OverviewTab } from './components/OverviewTab';
import { PainPointTab } from './components/PainPointTab';
import { TrendsTab } from './components/TrendsTab';
import { DetailsTab } from './components/DetailsTab';
import { useAppContext } from './context/AppContext';

function TabRouter() {
  const { activeTab } = useAppContext();

  switch (activeTab) {
    case 'overview':
      return <OverviewTab />;
    case 'painpoint':
      return <PainPointTab />;
    case 'trends':
      return <TrendsTab />;
    case 'details':
      return <DetailsTab />;
  }
}

function App() {
  const { ready, loading, error, availability } = useDuckDB();

  if (loading) {
    return (
      <div className="loading-overlay">
        <div className="spinner" />
        <h2>Initializing DuckDB-WASM…</h2>
        <p style={{ color: '#6B6B6B', fontSize: '0.875rem' }}>
          Loading Parquet data into the browser
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="error-banner">
        <h2>Initialization Error</h2>
        <p>{error}</p>
        <p style={{ marginTop: '0.75rem', fontSize: '0.8125rem', color: '#6B6B6B' }}>
          Make sure the pipeline has been run and Parquet files exist in <code>data/processed/</code>.
        </p>
      </div>
    );
  }

  if (!ready) return null;

  return (
    <AppProvider availability={availability}>
      <Layout>
        <TabRouter />
      </Layout>
    </AppProvider>
  );
}

export default App;
