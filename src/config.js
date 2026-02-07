import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// Load .env from backend project root so it works regardless of process cwd
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const CHAINS = {
  bellecour: {
    rpcHostUrl: "https://bellecour.iex.ec",
    ipfsGatewayUrl: "https://ipfs-gateway.v8-bellecour.iex.ec",
    iexecExplorerUrl: "https://explorer.iex.ec/bellecour",
    workerpool: "prod-v8-learn.main.pools.iexec.eth",
  },
};

const SCONE_TAG = ["tee", "scone"];
const TASK_OBSERVATION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export function getConfig() {
  const privateKey = process.env.IEXEC_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("Missing IEXEC_PRIVATE_KEY or PRIVATE_KEY in environment");
  }
  const chainName = process.env.IEXEC_CHAIN || "bellecour";
  const chain = CHAINS[chainName];
  if (!chain) {
    throw new Error(`Unsupported chain: ${chainName}. Use one of: ${Object.keys(CHAINS).join(", ")}`);
  }
  const appAddress = process.env.IEXEC_APP_ADDRESS;
  if (!appAddress) {
    throw new Error("Missing IEXEC_APP_ADDRESS in environment");
  }
  return {
    privateKey,
    chainName,
    chain,
    appAddress,
    SCONE_TAG,
    TASK_OBSERVATION_TIMEOUT_MS,
  };
}
