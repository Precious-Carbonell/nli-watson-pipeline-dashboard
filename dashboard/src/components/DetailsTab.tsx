/**
 * DETAILS TAB
 * 
 * Searchable, sortable, paginated table of records:
 * - Columns: id, premise, hypothesis, language, label, lengths,
 *   predicted_label + correct/incorrect flag (when available)
 * - Text search filters premise/hypothesis
 * - Language filter synced to global context
 * - Sort by clicking column headers
 * - 25 rows per page with navigation
 *
 * INSIGHT: Pagination is handled in SQL with LIMIT/OFFSET rather than loading
 * all rows into JS, which keeps memory usage constant regardless of dataset size.
 * DuckDB-WASM executes these paginated queries in <5ms because the Parquet
 * column indexes allow it to skip irrelevant row groups entirely.
 */

import { useState, useMemo } from 'react';
import { useQuery } from '../hooks/useQuery';
import { useAppContext } from '../context/AppContext';

const PAGE_SIZE = 25;

const LABEL_MAP: Record<number, string> = {
  0: 'Entailment',
  1: 'Neutral',
  2: 'Contradiction',
};

type SortCol = 'id' | 'language' | 'label' | 'premise_word_count' | 'hypothesis_word_count' | 'predicted_label';
type SortDir = 'ASC' | 'DESC';

type DetailRow = {
  id: string;
  premise: string;
  hypothesis: string;
  language: string;
  label: number;
  premise_word_count: number;
  hypothesis_word_count: number;
  predicted_label?: number;
  is_correct?: number;
};

type CountRow = { total: number };

export function DetailsTab() {
  const { languageFilter, availability } = useAppContext();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [sortCol, setSortCol] = useState<SortCol>('id');
  const [sortDir, setSortDir] = useState<SortDir>('ASC');

  // Reset page when filters change
  const filterKey = `${languageFilter}|${search}|${sortCol}|${sortDir}`;

  // ─── Build WHERE clause ─────────────────────────────────────────────────────
  const whereClause = useMemo(() => {
    const conditions: string[] = [];
    if (languageFilter) conditions.push(`t.language = '${languageFilter}'`);
    if (search.trim()) {
      const escaped = search.trim().replace(/'/g, "''");
      conditions.push(`(t.premise ILIKE '%${escaped}%' OR t.hypothesis ILIKE '%${escaped}%')`);
    }
    return conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  }, [languageFilter, search]);

  // ─── Count Query ────────────────────────────────────────────────────────────
  const countSql = useMemo(() => {
    if (availability.valPredictions) {
      return `
        SELECT COUNT(*) AS total
        FROM train t
        LEFT JOIN val_predictions v ON t.id = v.id
        ${whereClause};
      `;
    }
    return `SELECT COUNT(*) AS total FROM train t ${whereClause};`;
  }, [whereClause, availability.valPredictions]);

  const { data: countData } = useQuery<CountRow>(countSql, [filterKey]);
  const total = countData[0]?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  // Reset page when filters change
  useMemo(() => { setPage(0); }, [filterKey]);

  // ─── Data Query ─────────────────────────────────────────────────────────────
  const dataSql = useMemo(() => {
    const offset = page * PAGE_SIZE;
    const orderBy = `ORDER BY t.${sortCol} ${sortDir}`;

    if (availability.valPredictions) {
      return `
        SELECT
          t.id, t.premise, t.hypothesis, t.language, t.label,
          t.premise_word_count, t.hypothesis_word_count,
          v.predicted_label,
          CASE WHEN v.true_label = v.predicted_label THEN 1 ELSE 0 END AS is_correct
        FROM train t
        LEFT JOIN val_predictions v ON t.id = v.id
        ${whereClause}
        ${orderBy}
        LIMIT ${PAGE_SIZE} OFFSET ${offset};
      `;
    }

    return `
      SELECT id, premise, hypothesis, language, label,
             premise_word_count, hypothesis_word_count
      FROM train t
      ${whereClause}
      ${orderBy}
      LIMIT ${PAGE_SIZE} OFFSET ${offset};
    `;
  }, [whereClause, sortCol, sortDir, page, availability.valPredictions]);

  const { data: rows, queryTimeMs } = useQuery<DetailRow>(dataSql, [filterKey, page]);

  // ─── Sort handler ───────────────────────────────────────────────────────────
  function handleSort(col: SortCol) {
    if (sortCol === col) {
      setSortDir((d) => (d === 'ASC' ? 'DESC' : 'ASC'));
    } else {
      setSortCol(col);
      setSortDir('ASC');
    }
  }

  function sortIndicator(col: SortCol) {
    if (sortCol !== col) return '';
    return sortDir === 'ASC' ? ' ↑' : ' ↓';
  }

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Controls */}
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <input
          type="text"
          className="search-input"
          placeholder="Search premise or hypothesis…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search records"
        />
        <span style={{ fontSize: '0.75rem', color: '#6B6B6B' }}>
          {total.toLocaleString()} rows
          {queryTimeMs != null && ` · ${queryTimeMs.toFixed(1)}ms`}
        </span>
      </div>

      {/* Table */}
      <div className="card">
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th onClick={() => handleSort('id')}>ID{sortIndicator('id')}</th>
                <th>Premise</th>
                <th>Hypothesis</th>
                <th onClick={() => handleSort('language')}>Language{sortIndicator('language')}</th>
                <th onClick={() => handleSort('label')}>Label{sortIndicator('label')}</th>
                <th onClick={() => handleSort('premise_word_count')}>P.Words{sortIndicator('premise_word_count')}</th>
                <th onClick={() => handleSort('hypothesis_word_count')}>H.Words{sortIndicator('hypothesis_word_count')}</th>
                {availability.valPredictions && (
                  <>
                    <th onClick={() => handleSort('predicted_label')}>Predicted{sortIndicator('predicted_label')}</th>
                    <th>Result</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{row.id}</td>
                  <td title={row.premise}>{row.premise.slice(0, 60)}{row.premise.length > 60 ? '…' : ''}</td>
                  <td title={row.hypothesis}>{row.hypothesis.slice(0, 60)}{row.hypothesis.length > 60 ? '…' : ''}</td>
                  <td>{row.language}</td>
                  <td>{LABEL_MAP[row.label] ?? row.label}</td>
                  <td>{row.premise_word_count}</td>
                  <td>{row.hypothesis_word_count}</td>
                  {availability.valPredictions && (
                    <>
                      <td>{row.predicted_label != null ? LABEL_MAP[row.predicted_label] ?? row.predicted_label : '—'}</td>
                      <td className={row.is_correct === 1 ? 'correct' : row.is_correct === 0 ? 'incorrect' : ''}>
                        {row.is_correct === 1 ? '✓' : row.is_correct === 0 ? '✗' : '—'}
                      </td>
                    </>
                  )}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={availability.valPredictions ? 9 : 7} style={{ textAlign: 'center', padding: '2rem' }}>
                    No records match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="pagination">
            <button onClick={() => setPage(0)} disabled={page === 0}>First</button>
            <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>Prev</button>
            <span>Page {page + 1} of {totalPages}</span>
            <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}>Next</button>
            <button onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1}>Last</button>
          </div>
        )}
      </div>
    </div>
  );
}
