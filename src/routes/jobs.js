/**
 * Jobs API: persist settlement runs (taskId, dealId, result, etc.) in Postgres.
 * Requires DB to be configured; returns empty list / no-op when DB is not configured.
 */
import * as db from "../db.js";

function log(...args) {
  console.log(`[${new Date().toISOString()}] [jobs]`, ...args);
}

/**
 * POST /jobs
 * Body: { walletAddress?, taskId, dealId?, settlementName?, status?, result?, error?, datasetUrlOverride?, submittedAt? }
 */
export async function postJob(req, res) {
  try {
    if (!db.isDbConfigured()) {
      res.status(503).json({ error: "Database not configured. Set DATABASE_URL or PGHOST/PGDATABASE." });
      return;
    }
    await db.initDb();
    const body = req.body || {};
    const { walletAddress, taskId, dealId, settlementName, status, result, error, datasetUrlOverride, submittedAt } = body;
    if (!taskId || typeof taskId !== "string") {
      res.status(400).json({ error: "Missing or invalid taskId" });
      return;
    }
    const row = await db.createJob({
      wallet_address: walletAddress,
      task_id: taskId.trim(),
      deal_id: dealId,
      settlement_name: settlementName || "Settlement",
      status: status || "submitted",
      result: result ?? null,
      error: error ?? null,
      dataset_url_override: datasetUrlOverride ?? null,
      submitted_at: submittedAt ? new Date(submittedAt) : new Date(),
    });
    if (!row) {
      res.status(500).json({ error: "Failed to create job" });
      return;
    }
    res.status(201).json(jobRowToJson(row));
  } catch (err) {
    log("postJob error:", err.message);
    res.status(500).json({ error: err.message || "Failed to create job" });
  }
}

/**
 * GET /jobs?wallet=0x...
 * List jobs for the given wallet only. Wallet is required; returns [] when missing or DB not configured.
 */
export async function getJobs(req, res) {
  try {
    if (!db.isDbConfigured()) {
      res.json([]);
      return;
    }
    const wallet = req.query?.wallet != null ? String(req.query.wallet).trim() : null;
    if (!wallet || wallet === "") {
      res.json([]);
      return;
    }
    await db.initDb();
    const rows = await db.listJobs(wallet);
    res.json(rows.map(jobRowToJson));
  } catch (err) {
    log("getJobs error:", err.message);
    res.status(500).json({ error: err.message || "Failed to list jobs" });
  }
}

/**
 * PATCH /jobs/by-task/:taskId
 * Body: { status?, result?, error?, settledTxHash?, settledAt? }
 */
export async function patchJobByTaskId(req, res) {
  try {
    if (!db.isDbConfigured()) {
      res.status(503).json({ error: "Database not configured." });
      return;
    }
    const taskId = req.params?.taskId;
    if (!taskId) {
      res.status(400).json({ error: "Missing taskId" });
      return;
    }
    const body = req.body || {};
    const updates = {};
    if (body.status !== undefined) updates.status = body.status;
    if (body.result !== undefined) updates.result = body.result;
    if (body.error !== undefined) updates.error = body.error;
    if (body.settledTxHash !== undefined) updates.settledTxHash = body.settledTxHash;
    if (body.settledAt !== undefined) updates.settledAt = body.settledAt;
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No updates provided" });
      return;
    }
    const row = await db.updateJobByTaskId(taskId.trim(), updates);
    if (!row) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json(jobRowToJson(row));
  } catch (err) {
    log("patchJobByTaskId error:", err.message);
    res.status(500).json({ error: err.message || "Failed to update job" });
  }
}

function jobRowToJson(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    dealId: row.deal_id,
    settlementName: row.settlement_name,
    status: row.status,
    result: row.result,
    error: row.error,
    datasetUrlOverride: row.dataset_url_override,
    submittedAt: row.submitted_at ? new Date(row.submitted_at).getTime() : null,
    settledTxHash: row.settled_tx_hash ?? null,
    settledAt: row.settled_at ? new Date(row.settled_at).getTime() : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
