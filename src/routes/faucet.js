/**
 * Faucet route: mint Test USDC to a given address on Arbitrum Sepolia (for testing).
 * Requires FAUCET_PRIVATE_KEY (owner of TestUSDC), TEST_USDC_ADDRESS, ARBITRUM_SEPOLIA_RPC_URL.
 */
import { ethers } from "ethers";

const ARB_SEPOLIA_EXPLORER = "https://sepolia.arbiscan.io";
const DEFAULT_AMOUNT = "10000"; // 10,000 USDC (6 decimals applied in code)
const RATE_LIMIT_MS = 60 * 1000; // 1 request per address per minute
const addressLastRequest = new Map();

function getFaucetConfig() {
  const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL;
  const tokenAddress = process.env.TEST_USDC_ADDRESS;
  const privateKey = process.env.FAUCET_PRIVATE_KEY;
  if (!rpc || !tokenAddress || !privateKey) return null;
  return { rpc, tokenAddress, privateKey };
}

const TEST_USDC_ABI = [
  "function mint(address to, uint256 amount) external",
];

export async function postFaucet(req, res) {
  try {
    const config = getFaucetConfig();
    if (!config) {
      res.status(503).json({
        error: "Faucet not configured. Set ARBITRUM_SEPOLIA_RPC_URL, TEST_USDC_ADDRESS, and FAUCET_PRIVATE_KEY.",
      });
      return;
    }

    const { address } = req.body || {};
    if (!address || typeof address !== "string") {
      res.status(400).json({ error: "Missing or invalid address" });
      return;
    }
    const to = address.trim();
    if (!ethers.isAddress(to)) {
      res.status(400).json({ error: "Invalid Ethereum address" });
      return;
    }

    const now = Date.now();
    const last = addressLastRequest.get(to.toLowerCase());
    if (last != null && now - last < RATE_LIMIT_MS) {
      res.status(429).json({
        error: "Rate limited. Please wait a minute before requesting again.",
      });
      return;
    }
    addressLastRequest.set(to.toLowerCase(), now);

    const amount = ethers.parseUnits(DEFAULT_AMOUNT, 6);
    const provider = new ethers.JsonRpcProvider(config.rpc);
    const wallet = new ethers.Wallet(config.privateKey, provider);
    const contract = new ethers.Contract(config.tokenAddress, TEST_USDC_ABI, wallet);

    const tx = await contract.mint(to, amount);
    const receipt = await tx.wait();
    const txHash = receipt.hash;
    const explorerUrl = `${ARB_SEPOLIA_EXPLORER}/tx/${txHash}`;

    res.json({
      txHash,
      explorerUrl,
      amount: DEFAULT_AMOUNT,
      message: `Minted ${DEFAULT_AMOUNT} test USDC to ${to} on Arbitrum Sepolia.`,
    });
  } catch (err) {
    console.error("[faucet]", err);
    const message = err.reason ?? err.shortMessage ?? err.message ?? "Mint failed";
    res.status(500).json({ error: String(message) });
  }
}
