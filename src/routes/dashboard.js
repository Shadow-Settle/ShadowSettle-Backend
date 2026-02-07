/**
 * Dashboard API: aggregated stats (all wallets) and recent activity feed.
 */
import * as db from "../db.js";
import { getTreasuryBalanceFormatted } from "./settlement.js";

function log(...args) {
  console.log(`[${new Date().toISOString()}] [dashboard]`, ...args);
}

/**
 * GET /dashboard/stats
 * Returns totals for all wallets: treasury balance, job counts.
 */
export async function getStats(req, res) {
  try {
    const balance = await getTreasuryBalanceFormatted();
    const totalFundsDeposited = balance != null ? balance.formatted : "0";
    const totalFundsDepositedNum = balance != null ? balance.numeric : 0;
    let jobsRunning = 0;
    let settlementsCompleted = 0;
    let settlementsSettled = 0;
    let activePools = 0;

    if (db.isDbConfigured()) {
      await db.initDb();
      const jobs = await db.listAllJobs(2000);
      for (const j of jobs) {
        const hasResult = j.result != null;
        const hasSettled = j.settled_tx_hash != null;
        if (hasResult) settlementsCompleted += 1;
        if (hasSettled) settlementsSettled += 1;
        if (hasResult && !hasSettled) activePools += 1;
        if (!hasResult && !j.error) jobsRunning += 1;
      }
    }

    res.json({
      totalFundsDeposited,
      totalFundsDepositedNum,
      activePools,
      jobsRunning,
      settlementsCompleted,
      settlementsSettled,
    });
  } catch (err) {
    log("getStats error:", err.message);
    res.status(500).json({ error: err.message || "Failed to get dashboard stats" });
  }
}

/**
 * GET /dashboard/activity
 * Query: limit (optional), wallet (optional). When wallet is provided, returns only activity for that wallet.
 * Returns recent activity items derived from jobs: job_started, job_completed, settlement_executed.
 */
export async function getActivity(req, res) {
  try {
    const limit = Math.min(Number(req.query?.limit) || 30, 100);
    const wallet = req.query?.wallet != null ? String(req.query.wallet).trim() : null;
    const events = [];

    if (db.isDbConfigured()) {
      await db.initDb();
      const jobs = wallet
        ? await db.listJobs(wallet)
        : await db.listAllJobs(500);
      for (const j of jobs) {
        const settlementName = j.settlement_name || "Settlement";
        const participants = j.result?.payouts?.length ?? 0;
        const totalPayout = (j.result?.payouts ?? []).reduce((s, p) => s + (Number(p.amount) || 0), 0);

        if (j.submitted_at) {
          events.push({
            type: "job_started",
            taskId: j.task_id,
            settlementName,
            timestamp: new Date(j.submitted_at).getTime(),
            participants: null,
            totalPayout: null,
          });
        }
        if (j.result != null && j.updated_at) {
          events.push({
            type: "job_completed",
            taskId: j.task_id,
            settlementName,
            timestamp: new Date(j.updated_at).getTime(),
            participants,
            totalPayout: totalPayout > 0 ? totalPayout : null,
          });
        }
        if (j.settled_tx_hash != null && j.settled_at) {
          events.push({
            type: "settlement_executed",
            taskId: j.task_id,
            settlementName,
            timestamp: new Date(j.settled_at).getTime(),
            participants,
            totalPayout: totalPayout > 0 ? totalPayout : null,
          });
        }
      }
    }

    events.sort((a, b) => b.timestamp - a.timestamp);
    const slice = events.slice(0, limit);
    res.json({ activity: slice });
  } catch (err) {
    log("getActivity error:", err.message);
    res.status(500).json({ error: err.message || "Failed to get activity" });
  }
}
