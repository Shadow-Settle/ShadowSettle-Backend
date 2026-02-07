/**
 * Settlement routes: run iExec TEE app, get results, and execute on-chain.
 */
import { ethers } from "ethers";
import { runSettlementTask, waitForTask, fetchTaskResult, runSettlementAndWait } from "../iexec-client.js";
import * as db from "../db.js";

const ARB_SEPOLIA_EXPLORER = "https://sepolia.arbiscan.io";
const USDC_DECIMALS = 6;

function log(...args) {
  console.log(`[${new Date().toISOString()}] [settlement]`, ...args);
}

function getExecuteConfig() {
  const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL;
  const contractAddress = process.env.SETTLEMENT_CONTRACT_ADDRESS;
  const privateKey = process.env.SETTLEMENT_EXECUTOR_PRIVATE_KEY || process.env.FAUCET_PRIVATE_KEY;
  if (!rpc || !contractAddress || !privateKey) return null;
  return { rpc, contractAddress, privateKey };
}

const SETTLEMENT_ABI = [
  "function settleBatch(address[] calldata recipients, uint256[] calldata amounts, bytes calldata attestation) external",
  "function token() external view returns (address)",
  "function deposit(uint256 amount) external",
];

const ERC20_ABI = ["function balanceOf(address account) view returns (uint256)"];

function formatUsdc(raw) {
  const d = 10 ** USDC_DECIMALS;
  const whole = Number(raw / BigInt(d));
  const frac = Number(raw % BigInt(d));
  const fracStr = String(frac).padStart(USDC_DECIMALS, "0").slice(0, 2);
  return `${whole.toLocaleString()}.${fracStr}`;
}

/**
 * GET /settlement/config
 * Returns settlement and token addresses for the frontend (Arbitrum Sepolia).
 */
export async function getConfig(req, res) {
  log("[DEBUG] GET /settlement/config requested");
  try {
    const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL;
    const settlementAddress = process.env.SETTLEMENT_CONTRACT_ADDRESS;
    let tokenAddress = process.env.TEST_USDC_ADDRESS;
    log("[DEBUG] getConfig: rpc=", rpc ? "set" : "missing", "settlement=", settlementAddress || "missing", "token(env)=", tokenAddress || "missing");
    if (!rpc || !settlementAddress) {
      log("[DEBUG] getConfig: 503 missing config");
      res.status(503).json({
        error: "Settlement not configured. Set ARBITRUM_SEPOLIA_RPC_URL and SETTLEMENT_CONTRACT_ADDRESS.",
      });
      return;
    }
    if (!tokenAddress) {
      try {
        const provider = new ethers.JsonRpcProvider(rpc);
        const contract = new ethers.Contract(settlementAddress, SETTLEMENT_ABI, provider);
        tokenAddress = await contract.token();
        log("[DEBUG] getConfig: token from contract:", tokenAddress);
      } catch (e) {
        log("getConfig: could not read token from contract", e.message);
      }
    }
    log("[DEBUG] getConfig: 200 settlement=", settlementAddress, "token=", tokenAddress);
    res.json({
      settlementAddress,
      tokenAddress: tokenAddress || null,
      chainId: 421614,
      explorerUrl: ARB_SEPOLIA_EXPLORER,
    });
  } catch (err) {
    log("getConfig error:", err.message);
    res.status(500).json({ error: err.message || "Failed to get config" });
  }
}

/**
 * GET /settlement/network-info
 * Returns current block height and gas price from the chain (Arbitrum Sepolia).
 */
export async function getNetworkInfoRoute(req, res) {
  try {
    const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL;
    if (!rpc) {
      log("getNetworkInfo: ARBITRUM_SEPOLIA_RPC_URL not set");
      res.status(503).json({
        error: "Settlement not configured. Set ARBITRUM_SEPOLIA_RPC_URL.",
      });
      return;
    }
    const provider = new ethers.JsonRpcProvider(rpc);
    const [blockNumber, feeData] = await Promise.all([
      provider.getBlockNumber(),
      provider.getFeeData(),
    ]);
    const gasPriceWei = feeData.gasPrice ?? 0n;
    const gasPriceGwei = Number(gasPriceWei) / 1e9;
    const payload = {
      network: "Arbitrum Sepolia",
      blockHeight: blockNumber,
      gasPriceGwei: Math.round(gasPriceGwei * 100) / 100,
    };
    res.json(payload);
  } catch (err) {
    log("getNetworkInfo error:", err.message);
    res.status(500).json({ error: err.message || "Failed to get network info" });
  }
}

/**
 * GET /settlement/treasury-balance
 * Returns settlement contract USDC balance. Uses Postgres when configured:
 * - ?refresh=1: always read from chain, update DB, return.
 * - else: return from DB if present; otherwise read from chain, update DB, return.
 * Without Postgres: always reads from chain and returns.
 */
export async function getTreasuryBalanceRoute(req, res) {
  log("[DEBUG] GET /settlement/treasury-balance requested", "refresh=", req.query?.refresh);
  try {
    const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL;
    const settlementAddress = process.env.SETTLEMENT_CONTRACT_ADDRESS;
    let tokenAddress = process.env.TEST_USDC_ADDRESS;
    if (!rpc || !settlementAddress) {
      log("[DEBUG] getTreasuryBalance: 503 missing config");
      res.status(503).json({
        error: "Settlement not configured. Set ARBITRUM_SEPOLIA_RPC_URL and SETTLEMENT_CONTRACT_ADDRESS.",
      });
      return;
    }
    if (!tokenAddress) {
      try {
        const provider = new ethers.JsonRpcProvider(rpc);
        const contract = new ethers.Contract(settlementAddress, SETTLEMENT_ABI, provider);
        tokenAddress = await contract.token();
      } catch (e) {
        log("getTreasuryBalance: could not read token from contract", e.message);
        res.status(503).json({ error: "Could not resolve token address." });
        return;
      }
    }

    const forceRefresh = req.query?.refresh === "1" || req.query?.refresh === "true";
    const useDb = db.isDbConfigured();
    log("[DEBUG] getTreasuryBalance: forceRefresh=", forceRefresh, "useDb=", useDb);

    if (useDb && !forceRefresh) {
      await db.initDb();
      const stored = await db.getTreasuryBalance(settlementAddress);
      if (stored) {
        log("[DEBUG] getTreasuryBalance: 200 from DB balance=", stored.balanceFormatted);
        res.json({
          balanceFormatted: stored.balanceFormatted,
          balanceRaw: stored.balanceRaw,
          settlementAddress,
          source: "database",
        });
        return;
      }
    }

    const provider = new ethers.JsonRpcProvider(rpc);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const balanceRaw = await token.balanceOf(settlementAddress);
    const balanceFormatted = formatUsdc(balanceRaw);
    log("[DEBUG] getTreasuryBalance: from chain balanceRaw=", balanceRaw.toString(), "formatted=", balanceFormatted);

    if (useDb) {
      await db.initDb();
      await db.setTreasuryBalance(settlementAddress, balanceRaw.toString(), balanceFormatted);
    }

    res.json({
      balanceFormatted,
      balanceRaw: balanceRaw.toString(),
      settlementAddress,
      source: "chain",
    });
  } catch (err) {
    log("getTreasuryBalance error:", err.message);
    res.status(500).json({ error: err.message || "Failed to get treasury balance" });
  }
}

/**
 * Return current treasury balance formatted (for dashboard). Uses DB cache or chain.
 */
export async function getTreasuryBalanceFormatted() {
  const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL;
  const settlementAddress = process.env.SETTLEMENT_CONTRACT_ADDRESS;
  let tokenAddress = process.env.TEST_USDC_ADDRESS;
  if (!rpc || !settlementAddress) return null;
  if (db.isDbConfigured()) {
    await db.initDb();
    const stored = await db.getTreasuryBalance(settlementAddress);
    if (stored) return stored.balanceFormatted;
  }
  if (!tokenAddress) {
    try {
      const provider = new ethers.JsonRpcProvider(rpc);
      const contract = new ethers.Contract(settlementAddress, SETTLEMENT_ABI, provider);
      tokenAddress = await contract.token();
    } catch (e) {
      return null;
    }
  }
  try {
    const provider = new ethers.JsonRpcProvider(rpc);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const balanceRaw = await token.balanceOf(settlementAddress);
    return formatUsdc(balanceRaw);
  } catch (e) {
    return null;
  }
}

/**
 * POST /settlement/run
 * Body: { datasetUrl: string, wait?: boolean }
 * - If wait is false or omitted: returns { dealId, taskId } (fire-and-forget).
 * - If wait is true: waits for task completion and returns { dealId, taskId, result: { payouts, tee_attestation } }.
 */
export async function postRun(req, res) {
  try {
    const { datasetUrl, wait: waitForResult } = req.body || {};
    if (!datasetUrl || typeof datasetUrl !== "string") {
      log("rejected: missing or invalid datasetUrl");
      res.status(400).json({ error: "Missing or invalid datasetUrl" });
      return;
    }
    const url = datasetUrl.trim();
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      log("rejected: datasetUrl is not HTTP(S)");
      res.status(400).json({ error: "datasetUrl must be an HTTP(S) URL" });
      return;
    }

    log("datasetUrl:", url.slice(0, 60) + (url.length > 60 ? "..." : ""), "| wait:", !!waitForResult);

    if (waitForResult) {
      log("calling runSettlementAndWait...");
      const { dealId, taskId, result } = await runSettlementAndWait(url);
      log("runSettlementAndWait done, taskId:", taskId?.slice(0, 18) + "...", "| payouts:", result?.payouts?.length ?? 0);
      res.json({ dealId, taskId, result });
      return;
    }

    log("calling runSettlementTask (fire-and-forget)...");
    const { dealId, taskId } = await runSettlementTask(url);
    log("task submitted");
    log("  dealId (full):", dealId);
    log("  taskId (full):", taskId);
    log("  check status: https://explorer.iex.ec/bellecour/task/" + taskId);
    res.json({ dealId, taskId, message: "Task submitted. Use GET /settlement/result/:taskId to fetch the result." });
  } catch (err) {
    log("error:", err.message);
    console.error("POST /settlement/run error:", err);
    res.status(500).json({ error: err.message || "Failed to run settlement" });
  }
}

/**
 * GET /settlement/result/:taskId
 * Returns task result when completed: { status, result: { payouts, tee_attestation } }.
 */
export async function getResult(req, res) {
  try {
    const { taskId } = req.params;
    if (!taskId) {
      res.status(400).json({ error: "Missing taskId" });
      return;
    }
    const { status, result } = await fetchTaskResult(taskId);
    const isCompleted = status === "COMPLETED" || status === 3;
    log("GET result | taskId:", taskId, "| status:", status, isCompleted ? "(COMPLETED)" : "", "| payouts:", result?.payouts?.length ?? 0);
    res.json({ taskId, status, result });
  } catch (err) {
    log("error:", err.message);
    console.error("GET /settlement/result error:", err);
    res.status(500).json({ error: err.message || "Failed to fetch result" });
  }
}

/**
 * POST /settlement/wait/:taskId
 * Body: { dealId: string }
 * Waits for the task to complete, then returns the result.
 */
export async function postWait(req, res) {
  try {
    const { taskId } = req.params;
    const { dealId } = req.body || {};
    if (!taskId || !dealId) {
      res.status(400).json({ error: "Missing taskId or dealId" });
      return;
    }
    log("POST wait taskId:", taskId?.slice(0, 18) + "...");
    await waitForTask(taskId, dealId);
    log("task finalized, fetching result...");
    const { status, result } = await fetchTaskResult(taskId);
    log("result status:", status);
    res.json({ taskId, status, result });
  } catch (err) {
    log("error:", err.message);
    console.error("POST /settlement/wait error:", err);
    res.status(500).json({ error: err.message || "Failed to wait for task" });
  }
}

/**
 * POST /settlement/execute
 * Body: { recipients: string[], amounts: number[], attestation: string (0x-prefixed hex) }
 * Calls Settlement.settleBatch on Arbitrum Sepolia as executor; returns { txHash, explorerUrl }.
 */
export async function postExecute(req, res) {
  try {
    const config = getExecuteConfig();
    if (!config) {
      res.status(503).json({
        error: "On-chain settlement not configured. Set ARBITRUM_SEPOLIA_RPC_URL, SETTLEMENT_CONTRACT_ADDRESS, and SETTLEMENT_EXECUTOR_PRIVATE_KEY (or FAUCET_PRIVATE_KEY).",
      });
      return;
    }

    const { recipients, amounts, attestation } = req.body || {};
    if (!Array.isArray(recipients) || !Array.isArray(amounts) || recipients.length !== amounts.length) {
      res.status(400).json({ error: "Invalid body: need recipients and amounts arrays of the same length" });
      return;
    }
    if (!attestation || typeof attestation !== "string" || !attestation.startsWith("0x")) {
      res.status(400).json({ error: "Invalid attestation: must be 0x-prefixed hex string" });
      return;
    }
    if (recipients.length === 0) {
      res.status(400).json({ error: "At least one recipient required" });
      return;
    }

    // Normalize addresses to EIP-55 checksum (frontend/TEE may send wrong casing)
    const recipientsChecksummed = recipients.map((addr) => {
      const s = String(addr).trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new Error(`Invalid address: ${s}`);
      return ethers.getAddress(s.toLowerCase());
    });

    const provider = new ethers.JsonRpcProvider(config.rpc);
    const wallet = new ethers.Wallet(config.privateKey, provider);
    const contract = new ethers.Contract(config.contractAddress, SETTLEMENT_ABI, wallet);

    const amountsWei = amounts.map((a) => {
      const n = Number(a);
      if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid amount: ${a}`);
      return ethers.parseUnits(String(n), USDC_DECIMALS);
    });
    const attestationBytes = ethers.getBytes(attestation);

    log("execute: recipients:", recipientsChecksummed.length, "| total amount (human):", amounts.reduce((s, a) => s + Number(a), 0));
    const tx = await contract.settleBatch(recipientsChecksummed, amountsWei, attestationBytes);
    const receipt = await tx.wait();
    const txHash = receipt.hash;
    const explorerUrl = `${ARB_SEPOLIA_EXPLORER}/tx/${txHash}`;
    log("execute: txHash", txHash);
    res.json({ txHash, explorerUrl });
  } catch (err) {
    log("execute error:", err.message);
    console.error("POST /settlement/execute error:", err);
    const message = decodeSettlementRevert(err) ?? err.reason ?? err.shortMessage ?? err.message ?? "Settlement execute failed";
    res.status(500).json({ error: String(message) });
  }
}

/** Map Settlement contract custom error selector to a user-friendly message. */
function decodeSettlementRevert(err) {
  const data = err.data ?? err.info?.error?.data;
  if (typeof data !== "string" || !data.startsWith("0x")) return null;
  const selector = data.slice(0, 10).toLowerCase();
  if (selector === "0xf4d678b8") {
    return "Insufficient balance in settlement contract. Deposit USDC to the treasury first (Profile → Deposit USDC).";
  }
  if (selector === "0x17ee279c") {
    return "This settlement was already executed on-chain. Each attestation can only be used once. Open a different job or run a new confidential settlement.";
  }
  if (selector === "0x7fb6be02") {
    return "Only the configured executor can call settle. Check SETTLEMENT_EXECUTOR_PRIVATE_KEY matches the contract executor.";
  }
  return null;
}
