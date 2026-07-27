/**
 * TRENDS TAB
 * 
 * Displays:
 * - Top 10 languages by row count (horizontal bar)
 * - Top 10 lowest-accuracy languages (if val_predictions loaded, sorted ascending)
 * - Top 10 most-confused premise/hypothesis pairs (or top 10 longest premises fallback)
 * - 3×3 Confusion Matrix (if val_predictions loaded)
 *
 * INSIGHT: Sorting lowest accuracy ascending makes the "problem languages" jump
 * out immediately — a principle from information visualization where the most
 * actionable data should occupy the visual anchor position (top of list).
 * The confusion matrix uses conditional background intensity to encode magnitude.
 */

import { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { useQuery } from '../hooks/useQuery';
import { useAppContext } from '../context/AppContext';

// ─── Types ────────────────────────────────────────────────────────────────────

type LangRow = { language: string; row_count: number };
type AccLangRow = { language: string; accuracy: number };
type ConfusedRow = { premise: string; hypothesis: string; error_count?: number; premise_word_count?: number };
type CMRow = { true_label: number; predicted_label: number; cnt: number };

const LABELS = ['Entailment', 'Neutral', 'Contradiction'];

export function TrendsTab() {
  const { languageFilter, availability } = useAppContext();
  const langWhere = languageFilter ? `WHERE language = '${languageFilter}'` : '';

  // ─── Top 10 Languages by Row Count ──────────────────────────────────────────
  const topLangSql = useMemo(() => `
    SELECT language, COUNT(*) AS row_count
    FROM train ${langWhere}
    GROUP BY language
    ORDER BY row_count DESC
    LIMIT 10;
  `, [langWhere]);

  const { data: topLangs } = useQuery<LangRow>(topLangSql, [languageFilter]);

  // ─── Top 10 Lowest-Accuracy Languages ──────────────────────────────────────
  const lowAccSql = useMemo(() => {
    if (!availability.valPredictions) return null;
    const w = languageFilter ? `WHERE language = '${languageFilter}'` : '';
    return `
      SELECT language,
             ROUND(100.0 * COUNT(*) FILTER (WHERE true_label = predicted_label) / COUNT(*), 1) AS accuracy
      FROM val_predictions ${w}
      GROUP BY language
      HAVING COUNT(*) >= 5
      ORDER BY accuracy ASC
      LIMIT 10;
    `;
  }, [availability.valPredictions, languageFilter]);

  const { data: lowAccLangs } = useQuery<AccLangRow>(lowAccSql, [languageFilter]);

  // ─── Most Confused Pairs or Longest Premises ────────────────────────────────
  const confusedSql = useMemo(() => {
    if (availability.valPredictions) {
      const langJoin = languageFilter ? `AND v.language = '${languageFilter}'` : '';
      return `
        SELECT t.premise, t.hypothesis, COUNT(*) AS error_count
        FROM val_predictions v
        JOIN train t ON v.id = t.id
        WHERE v.true_label != v.predicted_label ${langJoin}
        GROUP BY t.premise, t.hypothesis
        ORDER BY error_count DESC
        LIMIT 10;
      `;
    }
    // Fallback: top 10 longest premises
    return `
      SELECT premise, hypothesis, premise_word_count
      FROM train ${langWhere}
      ORDER BY premise_word_count DESC
      LIMIT 10;
    `;
  }, [availability.valPredictions, languageFilter, langWhere]);

  const { data: confusedPairs } = useQuery<ConfusedRow>(confusedSql, [languageFilter]);

  // ─── Confusion Matrix ───────────────────────────────────────────────────────
  const cmSql = useMemo(() => {
    if (!availability.valPredictions) return null;
    const w = languageFilter ? `WHERE language = '${languageFilter}'` : '';
    return `
      SELECT true_label, predicted_label, COUNT(*) AS cnt
      FROM val_predictions ${w}
      GROUP BY true_label, predicted_label
      ORDER BY true_label, predicted_label;
    `;
  }, [availability.valPredictions, languageFilter]);

  const { data: cmData } = useQuery<CMRow>(cmSql, [languageFilter]);

  // Build 3×3 matrix
  const matrix = useMemo(() => {
    const m = Array.from({ length: 3 }, () => Array(3).fill(0) as number[]);
    for (const row of cmData) {
      if (row.true_label >= 0 && row.true_label <= 2 && row.predicted_label >= 0 && row.predicted_label <= 2) {
        m[row.true_label][row.predicted_label] = row.cnt;
      }
    }
    return m;
  }, [cmData]);

  const maxCm = useMemo(() => Math.max(1, ...matrix.flat()), [matrix]);

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Top 10 Languages by Row Count */}
      <div className="card">
        <h2>Top 10 Languages by Row Count</h2>
        <div className="chart-container">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={topLangs} layout="vertical" margin={{ top: 10, right: 20, bottom: 10, left: 100 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E0D8CC" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="language" tick={{ fontSize: 11 }} width={90} />
              <Tooltip contentStyle={{ background: '#fff', border: '1px solid #E0D8CC', borderRadius: '6px', fontSize: '0.8125rem' }} />
              <Bar dataKey="row_count" fill="#2D5016" radius={[0, 3, 3, 0]} name="Rows" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Top 10 Lowest-Accuracy Languages */}
      {availability.valPredictions && lowAccLangs.length > 0 && (
        <div className="card">
          <h2>Top 10 Lowest-Accuracy Languages</h2>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={lowAccLangs} layout="vertical" margin={{ top: 10, right: 20, bottom: 10, left: 100 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E0D8CC" horizontal={false} />
                <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11 }} unit="%" />
                <YAxis type="category" dataKey="language" tick={{ fontSize: 11 }} width={90} />
                <Tooltip
                  contentStyle={{ background: '#fff', border: '1px solid #E0D8CC', borderRadius: '6px', fontSize: '0.8125rem' }}
                  formatter={(value) => [`${value}%`, 'Accuracy']}
                />
                <Bar dataKey="accuracy" fill="#722F37" radius={[0, 3, 3, 0]} name="Accuracy %" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Most Confused Pairs or Longest Premises */}
      <div className="card">
        <h2>
          {availability.valPredictions
            ? 'Top 10 Most-Confused Premise/Hypothesis Pairs'
            : 'Top 10 Longest Premises (by word count)'}
        </h2>
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Premise</th>
                <th>Hypothesis</th>
                <th>{availability.valPredictions ? 'Errors' : 'Words'}</th>
              </tr>
            </thead>
            <tbody>
              {confusedPairs.map((row, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td title={row.premise}>{row.premise.slice(0, 80)}{row.premise.length > 80 ? '…' : ''}</td>
                  <td title={row.hypothesis}>{row.hypothesis.slice(0, 80)}{row.hypothesis.length > 80 ? '…' : ''}</td>
                  <td>{availability.valPredictions ? row.error_count : row.premise_word_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Confusion Matrix */}
      {availability.valPredictions && cmData.length > 0 && (
        <div className="card">
          <h2>Confusion Matrix (3×3)</h2>
          <p style={{ fontSize: '0.8125rem', color: '#6B6B6B', marginBottom: '0.75rem' }}>
            Rows = True Label, Columns = Predicted Label
          </p>
          <div className="confusion-matrix">
            {/* Header row */}
            <div className="cm-header"></div>
            {LABELS.map((l) => (
              <div key={`h-${l}`} className="cm-header">{l.slice(0, 5)}</div>
            ))}
            {/* Data rows */}
            {LABELS.map((rowLabel, ri) => (
              <>
                <div key={`l-${ri}`} className="cm-label">{rowLabel.slice(0, 5)}</div>
                {LABELS.map((_, ci) => {
                  const val = matrix[ri][ci];
                  const isDiag = ri === ci;
                  const opacity = 0.15 + 0.85 * (val / maxCm);
                  return (
                    <div
                      key={`${ri}-${ci}`}
                      className={`cm-cell ${isDiag ? 'diagonal' : 'off-diagonal'}`}
                      style={{
                        backgroundColor: isDiag
                          ? `rgba(45, 80, 22, ${opacity})`
                          : `rgba(114, 47, 55, ${Math.min(0.7, (val / maxCm) * 0.7)})`,
                        color: (isDiag && opacity > 0.5) || (!isDiag && val / maxCm > 0.3)
                          ? '#fff' : undefined,
                      }}
                    >
                      {val.toLocaleString()}
                    </div>
                  );
                })}
              </>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
