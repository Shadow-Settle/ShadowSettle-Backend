/**
 * Postgres connection and treasury balance persistence.
 * Set DATABASE_URL (or PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD) to enable.
 */
import pg from "pg";

const { Pool } = pg;

let pool = null;

function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url && !process.env.PGHOST && !process.env.PGDATABASE) return null;
  pool = new Pool(
    url
      ? { connectionString: url }
      : {
          host: process.env.PGHOST || "localhost",
          port: Number(process.env.PGPORT) || 5432,
          database: process.env.PGDATABASE || "shadowsettle",
          user: process.env.PGUSER || "postgres",
          password: process.env.PGPASSWORD || "",
        }
  );
  return pool;
}

const TABLE_TREASURY = "treasury_balance";
const TABLE_JOBS = "jobs";

export async function initDb() {
  const p = getPool();
  if (!p) return;
  await p.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE_TREASURY} (
      settlement_address TEXT PRIMARY KEY,
      balance_raw TEXT NOT NULL,
      balance_formatted TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE_JOBS} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      wallet_address TEXT,
      task_id TEXT UNIQUE NOT NULL,
      deal_id TEXT,
      settlement_name TEXT NOT NULL DEFAULT 'Settlement',
      status TEXT NOT NULL DEFAULT 'submitted',
      result JSONB,
      error TEXT,
      dataset_url_override TEXT,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      settled_tx_hash TEXT,
      settled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_jobs_wallet ON ${TABLE_JOBS}(wallet_address)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_jobs_submitted_at ON ${TABLE_JOBS}(submitted_at DESC)`);
  // Add settled columns if table already existed without them (Postgres 9.5+)
  await p.query(`ALTER TABLE ${TABLE_JOBS} ADD COLUMN IF NOT EXISTS settled_tx_hash TEXT`).catch(() => {});
  await p.query(`ALTER TABLE ${TABLE_JOBS} ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ`).catch(() => {});
}

/**
 * Get stored treasury balance for a settlement address. Returns null if not in DB.
 */
export async function getTreasuryBalance(settlementAddress) {
  const p = getPool();
  if (!p) return null;
  const r = await p.query(
    `SELECT balance_formatted, balance_raw, updated_at FROM ${TABLE_TREASURY} WHERE settlement_address = $1`,
    [settlementAddress.toLowerCase()]
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    balanceFormatted: row.balance_formatted,
    balanceRaw: row.balance_raw,
    updatedAt: row.updated_at,
  };
}

/**
 * Upsert treasury balance for a settlement address.
 */
export async function setTreasuryBalance(settlementAddress, balanceRaw, balanceFormatted) {
  const p = getPool();
  if (!p) return;
  const addr = settlementAddress.toLowerCase();
  await p.query(
    `INSERT INTO ${TABLE_TREASURY} (settlement_address, balance_raw, balance_formatted, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (settlement_address) DO UPDATE SET
       balance_raw = EXCLUDED.balance_raw,
       balance_formatted = EXCLUDED.balance_formatted,
       updated_at = NOW()`,
    [addr, String(balanceRaw), balanceFormatted]
  );
}

// --- Jobs ---

export async function createJob(data) {
  const p = getPool();
  if (!p) return null;
  const {
    wallet_address,
    task_id,
    deal_id,
    settlement_name = "Settlement",
    status = "submitted",
    result = null,
    error = null,
    dataset_url_override = null,
    submitted_at = new Date(),
  } = data;
  const r = await p.query(
    `INSERT INTO ${TABLE_JOBS} (wallet_address, task_id, deal_id, settlement_name, status, result, error, dataset_url_override, submitted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (task_id) DO UPDATE SET
       deal_id = COALESCE(EXCLUDED.deal_id, ${TABLE_JOBS}.deal_id),
       settlement_name = COALESCE(EXCLUDED.settlement_name, ${TABLE_JOBS}.settlement_name),
       status = EXCLUDED.status,
       result = COALESCE(EXCLUDED.result, ${TABLE_JOBS}.result),
       error = EXCLUDED.error,
       updated_at = NOW()
     RETURNING id, task_id, deal_id, settlement_name, status, result, error, submitted_at, created_at, updated_at`,
    [
      wallet_address ? String(wallet_address).toLowerCase() : null,
      task_id,
      deal_id || null,
      settlement_name,
      status,
      result != null ? JSON.stringify(result) : null,
      error || null,
      dataset_url_override || null,
      submitted_at instanceof Date ? submitted_at : new Date(submitted_at),
    ]
  );
  return r.rows[0];
}

/** List jobs for a single wallet only. walletAddress is required. */
export async function listJobs(walletAddress) {
  const p = getPool();
  if (!p) return [];
  if (walletAddress == null || String(walletAddress).trim() === "") return [];
  const r = await p.query(
    `SELECT id, task_id, deal_id, settlement_name, status, result, error, dataset_url_override, submitted_at, settled_tx_hash, settled_at, created_at, updated_at FROM ${TABLE_JOBS} WHERE wallet_address = $1 ORDER BY submitted_at DESC`,
    [String(walletAddress).toLowerCase()]
  );
  return r.rows;
}

/** List all jobs (for dashboard). Optional limit; default 500. */
export async function listAllJobs(limit = 500) {
  const p = getPool();
  if (!p) return [];
  const r = await p.query(
    `SELECT id, task_id, deal_id, settlement_name, status, result, error, dataset_url_override, submitted_at, settled_tx_hash, settled_at, created_at, updated_at FROM ${TABLE_JOBS} ORDER BY submitted_at DESC LIMIT $1`,
    [Math.min(Number(limit) || 500, 1000)]
  );
  return r.rows;
}

export async function updateJobByTaskId(taskId, updates) {
  const p = getPool();
  if (!p) return null;
  const { status, result, error, settledTxHash, settledAt } = updates;
  const setClauses = [];
  const values = [];
  let i = 1;
  if (status !== undefined) {
    setClauses.push(`status = $${i++}`);
    values.push(status);
  }
  if (result !== undefined) {
    setClauses.push(`result = $${i++}`);
    values.push(JSON.stringify(result));
  }
  if (error !== undefined) {
    setClauses.push(`error = $${i++}`);
    values.push(error);
  }
  if (settledTxHash !== undefined) {
    setClauses.push(`settled_tx_hash = $${i++}`);
    values.push(settledTxHash);
  }
  if (settledAt !== undefined) {
    setClauses.push(`settled_at = $${i++}`);
    values.push(settledAt);
  }
  if (setClauses.length === 0) return null;
  setClauses.push("updated_at = NOW()");
  values.push(taskId);
  const r = await p.query(
    `UPDATE ${TABLE_JOBS} SET ${setClauses.join(", ")} WHERE task_id = $${i} RETURNING id, task_id, deal_id, settlement_name, status, result, error, submitted_at, settled_tx_hash, settled_at, updated_at`,
    values
  );
  return r.rows.length > 0 ? r.rows[0] : null;
}

export function isDbConfigured() {
  return !!(process.env.DATABASE_URL || process.env.PGHOST || process.env.PGDATABASE);
}
