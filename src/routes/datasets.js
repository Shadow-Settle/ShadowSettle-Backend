/**
 * Temporary dataset storage so frontend can upload JSON and get a URL for iExec.
 * When backend is local, we also upload to a public file host so iExec workers can fetch the dataset.
 */
const store = new Map();

const PUBLIC_UPLOAD_0X0 = "https://0x0.st";
const PUBLIC_UPLOAD_TRANSFER = "https://transfer.sh";

/**
 * Upload JSON to a public file host so iExec workers (on the internet) can fetch it.
 * Tries 0x0.st first, then transfer.sh. Returns the public URL or null on failure.
 */
async function uploadToPublicHost(jsonObject) {
  const body = JSON.stringify(jsonObject);

  // Try 0x0.st (multipart)
  try {
    const form = new FormData();
    form.append("file", new Blob([body], { type: "application/json" }), "dataset.json");
    const response = await fetch(PUBLIC_UPLOAD_0X0, {
      method: "POST",
      body: form,
      headers: { "User-Agent": "ShadowSettle-Backend/1.0" },
    });
    const text = (await response.text()).trim();
    if (!response.ok) {
      log("0x0.st response", response.status, "body:", text.slice(0, 100));
    } else if (text.startsWith("http")) {
      return text;
    } else if (text.startsWith("/")) {
      return PUBLIC_UPLOAD_0X0.replace(/\/$/, "") + text;
    } else {
      log("0x0.st body (no URL):", text.slice(0, 100));
    }
  } catch (e) {
    log("0x0.st error:", e.message);
  }

  // Fallback: transfer.sh (PUT)
  try {
    const response = await fetch(`${PUBLIC_UPLOAD_TRANSFER}/dataset.json`, {
      method: "PUT",
      body,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "ShadowSettle-Backend/1.0",
      },
    });
    const text = (await response.text()).trim();
    if (response.ok && text.startsWith("http")) return text;
    log("transfer.sh response", response.status, "body:", text.slice(0, 100));
  } catch (e) {
    log("transfer.sh error:", e.message);
  }

  return null;
}

function log(...args) {
  console.log(`[${new Date().toISOString()}] [datasets]`, ...args);
}

export async function postDataset(req, res) {
  try {
    const body = req.body;
    if (!body || typeof body !== "object") {
      log("rejected: body is not a JSON object");
      res.status(400).json({ error: "Request body must be a JSON object (dataset)" });
      return;
    }
    const keys = Object.keys(body);
    log("received dataset, keys:", keys.join(", "));

    const id = Math.random().toString(36).slice(2, 12);
    store.set(id, body);
    const baseUrl = process.env.BACKEND_PUBLIC_URL || `http://localhost:${process.env.PORT || 3001}`;
    const url = `${baseUrl.replace(/\/$/, "")}/datasets/${id}.json`;
    log("stored id:", id, "| local url:", url);

    let publicUrl = null;
    try {
      log("uploading to public host (0x0.st)...");
      publicUrl = await uploadToPublicHost(body);
      if (publicUrl) {
        log("publicUrl:", publicUrl);
      } else {
        log("public upload returned no URL");
      }
    } catch (e) {
      log("public upload failed:", e.message);
    }

    res.status(201).json({ id, url, ...(publicUrl && { publicUrl }) });
    log("response 201, id:", id);
  } catch (err) {
    log("error:", err.message);
    console.error("POST /datasets error:", err);
    res.status(500).json({ error: err.message || "Failed to store dataset" });
  }
}

export function getDataset(req, res) {
  const id = req.params.id?.replace(/\.json$/, "");
  if (!id) {
    res.status(400).json({ error: "Missing dataset id" });
    return;
  }
  const data = store.get(id);
  if (!data) {
    console.log(`[${new Date().toISOString()}] [datasets] GET ${id}.json — not found`);
    res.status(404).json({ error: "Dataset not found" });
    return;
  }
  console.log(`[${new Date().toISOString()}] [datasets] GET ${id}.json — 200`);
  res.setHeader("Content-Type", "application/json");
  res.json(data);
}
