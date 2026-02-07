/**
 * iExec client: run ShadowSettle TEE app, wait for task, fetch result.
 */
import { ethers } from "ethers";
import { IExec } from "iexec";
import AdmZip from "adm-zip";
import { getConfig } from "./config.js";

function log(...args) {
  console.log(`[${new Date().toISOString()}] [iexec]`, ...args);
}

function getIExec(signer, chain) {
  const provider = new ethers.JsonRpcProvider(chain.rpcHostUrl);
  const connectedSigner = signer.connect(provider);
  return new IExec(
    { ethProvider: connectedSigner },
    { allowExperimentalNetworks: true }
  );
}

/**
 * Run the settlement app on iExec with a public dataset URL.
 * Returns { dealId, taskId }.
 */
export async function runSettlementTask(datasetUrl) {
  log("runSettlementTask datasetUrl:", datasetUrl?.slice(0, 50) + (datasetUrl?.length > 50 ? "..." : ""));
  const { privateKey, chain, appAddress, SCONE_TAG } = getConfig();
  const wallet = new ethers.Wallet(privateKey);
  const iexec = getIExec(wallet, chain);
  const userAddress = await wallet.getAddress();

  log("checking app at", appAddress);
  if (!(await iexec.app.checkDeployedApp(appAddress))) {
    throw new Error(`No iApp found at ${appAddress}`);
  }

  log("creating app order...");
  const apporderTemplate = await iexec.order.createApporder({
    app: appAddress,
    requesterrestrict: userAddress,
    tag: SCONE_TAG,
  });
  const apporder = await iexec.order.signApporder(apporderTemplate);

  log("fetching workerpool orderbook...");
  const workerpoolOrderbook = await iexec.orderbook.fetchWorkerpoolOrderbook({
    workerpool: chain.workerpool,
    app: appAddress,
    minTag: SCONE_TAG,
    maxTag: SCONE_TAG,
    minVolume: 1,
  });
  const workerpoolorder = workerpoolOrderbook.orders[0]?.order;
  if (!workerpoolorder) {
    throw new Error("No workerpool order found. Try again later.");
  }
  log("workerpool order found");

  log("creating request order (iexec_input_files: [datasetUrl])...");
  const requestorderToSign = await iexec.order.createRequestorder({
    app: appAddress,
    category: workerpoolorder.category,
    dataset: ethers.ZeroAddress,
    appmaxprice: apporder.appprice,
    datasetmaxprice: 0,
    workerpoolmaxprice: workerpoolorder.workerpoolprice,
    tag: SCONE_TAG,
    volume: 1,
    params: {
      iexec_input_files: [datasetUrl],
    },
  });
  const requestorder = await iexec.order.signRequestorder(requestorderToSign);

  log("matching orders...");
  const { dealid } = await iexec.order.matchOrders({
    apporder,
    datasetorder: undefined,
    workerpoolorder,
    requestorder,
  });
  const taskid = await iexec.deal.computeTaskId(dealid, 0);
  log("deal matched — dealId (full):", dealid);
  log("taskId (full):", taskid);
  return { dealId: dealid, taskId: taskid };
}

/**
 * Wait for task to complete (observable completes when finalized).
 */
export async function waitForTask(taskId, dealId) {
  log("waitForTask: observing task (timeout 10min)...");
  const { privateKey, chain, TASK_OBSERVATION_TIMEOUT_MS } = getConfig();
  const wallet = new ethers.Wallet(privateKey);
  const iexec = getIExec(wallet, chain);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      log("waitForTask: timeout");
      reject(new Error("Task observation timeout"));
    }, TASK_OBSERVATION_TIMEOUT_MS);

    iexec.task.obsTask(taskId, { dealid: dealId }).then((obs) => {
      obs.subscribe({
        next: () => {},
        error: (e) => {
          clearTimeout(timeout);
          log("waitForTask: error", e?.message ?? e);
          reject(e);
        },
        complete: () => {
          clearTimeout(timeout);
          log("waitForTask: task finalized");
          resolve();
        },
      });
    }).catch(reject);
  });
}

/**
 * Fetch task result zip and parse result.json.
 * Returns { payouts, tee_attestation }.
 */
export async function fetchTaskResult(taskId) {
  log("fetchTaskResult taskId:", taskId?.slice(0, 18) + "...");
  const { privateKey, chain } = getConfig();
  const wallet = new ethers.Wallet(privateKey);
  const iexec = getIExec(wallet, chain);

  const task = await iexec.task.show(taskId);
  const status = task?.status;
  const isCompleted = status === 3 || status === "COMPLETED"; // iExec SDK returns numeric 3 for COMPLETED
  log("task status:", status, isCompleted ? "(COMPLETED)" : "");
  if (!isCompleted) {
    return { status: status ?? "UNKNOWN", result: null };
  }

  log("fetching result zip...");
  const resultResponse = await iexec.task.fetchResults(taskId);
  const arrayBuffer = await resultResponse.arrayBuffer();
  const zip = new AdmZip(Buffer.from(arrayBuffer));
  const resultEntry = zip.getEntry("result.json");
  if (!resultEntry) {
    throw new Error("result.json not found in task output");
  }
  const result = JSON.parse(resultEntry.getData().toString("utf8"));
  log("result parsed, payouts:", result?.payouts?.length ?? 0);
  return { status: "COMPLETED", result };
}

/**
 * Run settlement and wait for result, then return parsed result.
 */
export async function runSettlementAndWait(datasetUrl) {
  const { dealId, taskId } = await runSettlementTask(datasetUrl);
  await waitForTask(taskId, dealId);
  log("fetching result...");
  const { result } = await fetchTaskResult(taskId);
  return { dealId, taskId, result };
}
