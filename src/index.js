/**
 * ShadowSettle backend — iExec TEE settlement API.
 */
import express from "express";
import cors from "cors";
import { getConfig } from "./config.js";
import * as settlement from "./routes/settlement.js";
import * as datasets from "./routes/datasets.js";
import * as faucet from "./routes/faucet.js";
import * as jobs from "./routes/jobs.js";
import * as dashboard from "./routes/dashboard.js";
import * as health from "./routes/health.js";
import * as db from "./db.js";

const app = express();

// Allow frontend origin(s). Comma-separated list; default includes production and localhost.
const allowedOrigins = (process.env.CORS_ORIGIN || "https://shadowsettle.0xo.in,http://localhost:3000,http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  })
);

// Normalize double (or multiple) slashes in path so //health/checks -> /health/checks
app.use((req, res, next) => {
  const [pathPart, queryPart] = req.url.split("?");
  const normalized = pathPart.replace(/\/+/g, "/") + (queryPart ? `?${queryPart}` : "");
  if (normalized !== req.url) req.url = normalized;
  next();
});

app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3001;

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

app.use((req, res, next) => {
  let bodySummary = "";
  if (["POST", "PUT", "PATCH"].includes(req.method) && req.body && typeof req.body === "object") {
    bodySummary = req.body.datasetUrl !== undefined
      ? `datasetUrl=${req.body.datasetUrl?.slice?.(0, 50)}..., wait=${req.body.wait}`
      : `keys=${Object.keys(req.body).join(", ")}`;
  }
  log(`${req.method} ${req.path}`, bodySummary ? `— ${bodySummary}` : "");
  next();
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/datasets", datasets.postDataset);
app.get("/datasets/:id.json", datasets.getDataset);

app.get("/settlement/config", settlement.getConfig);
app.get("/settlement/network-info", settlement.getNetworkInfoRoute);
app.get("/settlement/treasury-balance", settlement.getTreasuryBalanceRoute);
app.post("/settlement/run", settlement.postRun);
app.get("/settlement/result/:taskId", settlement.getResult);
app.post("/settlement/wait/:taskId", settlement.postWait);
app.post("/settlement/execute", settlement.postExecute);

app.post("/faucet", faucet.postFaucet);

app.get("/jobs", jobs.getJobs);
app.post("/jobs", jobs.postJob);
app.patch("/jobs/by-task/:taskId", jobs.patchJobByTaskId);

app.get("/dashboard/stats", dashboard.getStats);
app.get("/dashboard/activity", dashboard.getActivity);

app.get("/health/checks", health.getHealthChecks);

try {
  getConfig();
} catch (e) {
  console.error("Startup config error:", e.message);
  console.error("Set IEXEC_PRIVATE_KEY (or PRIVATE_KEY), IEXEC_APP_ADDRESS, and optionally IEXEC_CHAIN=bellecour");
  process.exit(1);
}

if (db.isDbConfigured()) {
  db.initDb().then(() => log("Postgres treasury_balance table ready")).catch((e) => log("Postgres init:", e.message));
}

app.listen(PORT, () => {
  console.log(`ShadowSettle backend listening on http://localhost:${PORT}`);
  console.log("  POST /datasets         — upload dataset JSON, get URL (body: <dataset object>)");
  console.log("  POST /settlement/run   — run TEE settlement (body: { datasetUrl [, wait: true] })");
  console.log("  GET  /settlement/result/:taskId — get result for a task");
  console.log("  POST /settlement/wait/:taskId   — wait for task then get result (body: { dealId })");
  console.log("  POST /settlement/execute        — execute settlement on-chain (body: { recipients, amounts, attestation })");
  console.log("  POST /faucet          — mint test USDC on Arbitrum Sepolia (body: { address })");
  console.log("  GET  /jobs             — list jobs (query: ?wallet=0x...)");
  console.log("  POST /jobs             — create/upsert job (body: { taskId, dealId, settlementName, ... })");
  console.log("  PATCH /jobs/by-task/:taskId — update job result/error");
});
