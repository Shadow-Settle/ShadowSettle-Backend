/**
 * Health checks for System Status: backend, iExec, blockchain.
 */
import { ethers } from "ethers";
import { getConfig } from "../config.js";

function log(...args) {
  console.log(`[${new Date().toISOString()}] [health]`, ...args);
}

/**
 * GET /health/checks
 * Returns { backend: true, iexec: boolean, chain: boolean, checkedAt: number }.
 * Green when each is up.
 */
export async function getHealthChecks(req, res) {
  const checkedAt = Date.now();
  const result = { backend: true, iexec: false, chain: false, checkedAt };

  try {
    getConfig();
    result.iexec = true;
  } catch (e) {
    log("iExec check:", e.message);
  }

  const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL;
  if (rpc) {
    try {
      const provider = new ethers.JsonRpcProvider(rpc);
      await provider.getBlockNumber();
      result.chain = true;
    } catch (e) {
      log("Chain check:", e.message);
    }
  }

  res.json(result);
}
