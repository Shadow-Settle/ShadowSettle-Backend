# shadowsettle_backend

Node.js API for **ShadowSettle**: orchestrates iExec TEE jobs, serves settlement config and treasury balance, and executes on-chain settlements.

Part of the [ShadowSettle](https://github.com/ShadowSettle/ShadowSettle) monorepo.

---

## Stack

- **Node.js** (>= 20), **Express**, **cors**
- **iExec SDK** — run and wait for TEE tasks
- **ethers.js** — settlement config, treasury balance, network info, `settleBatch` execution
- **Postgres** (optional) — persist treasury balance and job records

---

## Setup

1. Copy env and set variables:

```bash
cp .env.example .env
```

See `.env.example` for:

- `IEXEC_PRIVATE_KEY`, `IEXEC_APP_ADDRESS`, `IEXEC_CHAIN` (required for iExec)
- `ARBITRUM_SEPOLIA_RPC_URL`, `SETTLEMENT_CONTRACT_ADDRESS` (required for config/treasury/execute)
- `TEST_USDC_ADDRESS` (optional; can be read from contract)
- `SETTLEMENT_EXECUTOR_PRIVATE_KEY` or `FAUCET_PRIVATE_KEY` (for POST /settlement/execute)
- `DATABASE_URL` (optional; for Postgres and jobs/treasury persistence)

2. Install and run:

```bash
npm install
npm start
# or
npm run dev
```

Server listens on `PORT` (default **3001**).

---

## Main routes

| Method | Route | Description |
|--------|--------|-------------|
| GET | `/health` | Liveness |
| GET | `/settlement/config` | Settlement + token address, chainId, explorer |
| GET | `/settlement/network-info` | Block height, gas price (Arbitrum Sepolia) |
| GET | `/settlement/treasury-balance` | Treasury USDC balance (`?refresh=1` to force chain) |
| POST | `/settlement/run` | Run TEE settlement (body: `datasetUrl`, optional `wait`) |
| GET | `/settlement/result/:taskId` | Get TEE result for a task |
| POST | `/settlement/execute` | Execute settleBatch on-chain (body: `recipients`, `amounts`, `attestation`) |
| GET | `/jobs` | List jobs (`?wallet=0x...`) |
| POST | `/jobs` | Create/upsert job |
| PATCH | `/jobs/by-task/:taskId` | Update job (result, error, settled) |
| GET | `/dashboard/stats` | Dashboard stats |
| GET | `/dashboard/activity` | Recent activity (`?wallet=`, `?limit=`) |
| GET | `/health/checks` | Backend, iExec, chain health |
| POST | `/datasets` | Upload dataset JSON, get URL |
| POST | `/faucet` | Mint test USDC (if configured) |

---

## Env summary

- **iExec:** `IEXEC_PRIVATE_KEY`, `IEXEC_APP_ADDRESS`, `IEXEC_CHAIN`
- **Arbitrum Sepolia:** `ARBITRUM_SEPOLIA_RPC_URL`, `SETTLEMENT_CONTRACT_ADDRESS`, `TEST_USDC_ADDRESS`
- **Execute:** `SETTLEMENT_EXECUTOR_PRIVATE_KEY` (or `FAUCET_PRIVATE_KEY`)
- **Optional:** `DATABASE_URL`, `PORT`, `FAUCET_PRIVATE_KEY` (for faucet)
