/**
 * DuckDB-WASM Initialization & Parquet Loading
 * 
 * Initializes DuckDB-WASM with the EH (exception handling) bundle,
 * registers Parquet files into DuckDB's virtual file system, and
 * feature-detects optional files (training_log, val_predictions)
 * without crashing if they don't exist.
 *
 * INSIGHT: We use the EH (exception handling) WASM bundle rather than MVP
 * because modern browsers support WASM exceptions, giving us better error
 * messages and ~10% faster query execution on aggregate workloads.
 * The singleton pattern ensures only one DuckDB instance exists across
 * React's StrictMode double-renders and fast-refresh cycles.
 */

import * as duckdb from '@duckdb/duckdb-wasm';
import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';

// Paths to Parquet files served from /data/processed/ via Vite's public dir or relative path
const PARQUET_FILES = {
  train: '/data/processed/train_cleaned.parquet',
  test: '/data/processed/test_cleaned.parquet',
  trainingLog: '/data/processed/training_log_cleaned.parquet',
  valPredictions: '/data/processed/val_predictions_cleaned.parquet',
} as const;

export type DataAvailability = {
  train: boolean;
  test: boolean;
  trainingLog: boolean;
  valPredictions: boolean;
};

let dbInstance: AsyncDuckDB | null = null;
let initPromise: Promise<{ db: AsyncDuckDB; availability: DataAvailability }> | null = null;

/**
 * Attempts to fetch a file and register it in DuckDB's virtual filesystem.
 * Returns true only if the file is a valid Parquet file (checks magic bytes).
 * Returns false if the file doesn't exist, is invalid, or fetch fails.
 */
async function registerParquetFile(
  db: AsyncDuckDB,
  url: string,
  tableName: string
): Promise<boolean> {
  try {
    const response = await fetch(url);
    if (!response.ok) return false;

    // Reject HTML responses (Vite SPA fallback returns 200 + HTML for missing files)
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/html')) return false;

    const buffer = await response.arrayBuffer();

    // Parquet files must be at least 12 bytes and start with magic bytes "PAR1"
    if (buffer.byteLength < 12) return false;
    const header = new Uint8Array(buffer, 0, 4);
    const magic = String.fromCharCode(header[0], header[1], header[2], header[3]);
    if (magic !== 'PAR1') return false;

    await db.registerFileBuffer(
      `${tableName}.parquet`,
      new Uint8Array(buffer)
    );
    return true;
  } catch {
    // Network error or fetch failure — file not available
    return false;
  }
}

/**
 * Initialize DuckDB-WASM (singleton). Registers all available Parquet files.
 * Safe to call multiple times — returns the same promise.
 */
export function initDuckDB(): Promise<{ db: AsyncDuckDB; availability: DataAvailability }> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // Select the best bundle for this browser
    const DUCKDB_BUNDLES = await duckdb.selectBundle({
      mvp: {
        mainModule: new URL(
          '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm',
          import.meta.url
        ).href,
        mainWorker: new URL(
          '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js',
          import.meta.url
        ).href,
      },
      eh: {
        mainModule: new URL(
          '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm',
          import.meta.url
        ).href,
        mainWorker: new URL(
          '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js',
          import.meta.url
        ).href,
      },
    });

    const logger = new duckdb.ConsoleLogger();
    const worker = new Worker(DUCKDB_BUNDLES.mainWorker!);
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(DUCKDB_BUNDLES.mainModule);

    dbInstance = db;

    // Register Parquet files — required ones throw, optional ones gracefully degrade
    const trainOk = await registerParquetFile(db, PARQUET_FILES.train, 'train');
    if (!trainOk) {
      throw new Error('Required file train_cleaned.parquet not found. Run the pipeline first.');
    }

    const testOk = await registerParquetFile(db, PARQUET_FILES.test, 'test');
    if (!testOk) {
      throw new Error('Required file test_cleaned.parquet not found. Run the pipeline first.');
    }

    // Optional files — feature-detect without crashing
    let trainingLogOk = await registerParquetFile(db, PARQUET_FILES.trainingLog, 'training_log');
    let valPredictionsOk = await registerParquetFile(db, PARQUET_FILES.valPredictions, 'val_predictions');

    // Create views for convenient querying
    const conn = await db.connect();
    await conn.query(`CREATE VIEW train AS SELECT * FROM read_parquet('train.parquet')`);
    await conn.query(`CREATE VIEW test AS SELECT * FROM read_parquet('test.parquet')`);

    if (trainingLogOk) {
      try {
        await conn.query(`CREATE VIEW training_log AS SELECT * FROM read_parquet('training_log.parquet')`);
      } catch (e) {
        console.warn('[DuckDB-WASM] training_log.parquet registered but invalid, skipping:', e);
        trainingLogOk = false;
      }
    }
    if (valPredictionsOk) {
      try {
        await conn.query(`CREATE VIEW val_predictions AS SELECT * FROM read_parquet('val_predictions.parquet')`);
      } catch (e) {
        console.warn('[DuckDB-WASM] val_predictions.parquet registered but invalid, skipping:', e);
        valPredictionsOk = false;
      }
    }

    await conn.close();

    const availability: DataAvailability = {
      train: trainOk,
      test: testOk,
      trainingLog: trainingLogOk,
      valPredictions: valPredictionsOk,
    };

    console.log('[DuckDB-WASM] Initialized. Data availability:', availability);
    return { db, availability };
  })();

  return initPromise;
}

/**
 * Get a connection to the initialized DuckDB instance.
 * Throws if called before initialization completes.
 */
export async function getConnection(): Promise<AsyncDuckDBConnection> {
  if (!dbInstance) {
    const { db } = await initDuckDB();
    return db.connect();
  }
  return dbInstance.connect();
}

/**
 * Execute a SQL query and return results as an array of row objects.
 * Logs query time to console for performance auditing.
 */
export async function queryDuckDB<T = Record<string, unknown>>(
  sql: string
): Promise<{ rows: T[]; queryTimeMs: number }> {
  const conn = await getConnection();
  const start = performance.now();

  try {
    const result = await conn.query(sql);
    const queryTimeMs = performance.now() - start;

    // Convert Arrow table to JS objects
    const rows = result.toArray().map((row) => {
      const obj: Record<string, unknown> = {};
      for (const field of result.schema.fields) {
        const val = row[field.name];
        // Convert BigInt to Number for chart consumption
        obj[field.name] = typeof val === 'bigint' ? Number(val) : val;
      }
      return obj;
    }) as T[];

    console.log(`[DuckDB] ${queryTimeMs.toFixed(1)}ms | ${sql.slice(0, 80)}...`);
    return { rows, queryTimeMs };
  } finally {
    await conn.close();
  }
}
