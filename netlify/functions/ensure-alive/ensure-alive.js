// ============================================================================
// NEXUS ensure-alive v2 — DUAL-ACCOUNT auto-wake
// Manages the engine on up to TWO Kaggle accounts (separate GPUs, quotas,
// 30h/week each). Returns an alive engine URL, or wakes whichever account
// has quota left. Kaggle tokens live ONLY in Netlify env vars:
//   KAGGLE_KEY        = account A token (required)
//   KAGGLE_USERNAME   = account A username (from env)
//   KAGGLE_KEY_B      = account B token (optional)
//   KAGGLE_USERNAME_B = account B username (optional)
// Responses:
//   { status:"alive",  url:"...", engines:[{url,ageMinutes}], model:"..." }
//   { status:"waking", etaMinutes:10, reason:"..." }
//   { status:"error",  message:"..." }  (502 — e.g. both accounts out of quota)
// ============================================================================

const fs = require("fs");
const path = require("path");

const KERNEL_SLUG = "qwen-3-8-27b-uncensored-chat";
const KERNEL_TITLE = "Qwen 3.8 27B Uncensored Chat";
const API = "https://www.kaggle.com/api/v1";
const BEACON =
  "https://REMOVED_WEBHOOK_TOKEN/requests?sorting=newest";
const NTFY = "https://ntfy.sh/REMOVED_BEACON_TOPIC/json?poll=1&since=12h";
const MODEL_NAME = "hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:IQ4_XS";

const ACCOUNTS = [
  { user: process.env.KAGGLE_USERNAME, key: process.env.KAGGLE_KEY, ds: process.env.KAGGLE_DATASET_A ? [process.env.KAGGLE_DATASET_A] : [] },
  { user: process.env.KAGGLE_USERNAME_B, key: process.env.KAGGLE_KEY_B, ds: [] },
].filter((a) => a.key && a.user); // usernames come ONLY from env - never hardcoded

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { ...CORS, "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

async function fetchJson(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await r.text();
    try {
      return { code: r.status, json: JSON.parse(text) };
    } catch {
      return { code: r.status, json: null, text: text.slice(0, 200) };
    }
  } finally {
    clearTimeout(t);
  }
}

// --- newest LIVE LINKs from BOTH beacons (newest first) ----------------------
async function getLinks() {
  const out = [];
  const jobs = await Promise.allSettled([
    fetchJson(BEACON, {}, 15000),
    fetch(NTFY, { signal: AbortSignal.timeout(15000) }).then((r) => r.text()),
  ]);
  if (jobs[0].status === "fulfilled" && jobs[0].value.json) {
    for (const it of jobs[0].value.json.data || []) {
      const m = (it.query && it.query.m) || "";
      const u = m.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (u && m.includes("LIVE LINK"))
        out.push({ url: u[0], ageMinutes: Math.round((Date.now() - new Date(it.created_at)) / 60000) });
    }
  }
  if (jobs[1].status === "fulfilled" && typeof jobs[1].value === "string") {
    for (const line of jobs[1].value.split("\n")) {
      try {
        const d = JSON.parse(line);
        const u = (d.message || "").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (u && d.message.includes("LIVE LINK"))
          out.push({ url: u[0], ageMinutes: Math.round((Date.now() - d.time * 1000) / 60000) });
      } catch {}
    }
  }
  // dedupe by url, keep youngest age
  const best = {};
  for (const l of out) if (!best[l.url] || l.ageMinutes < best[l.url].ageMinutes) best[l.url] = l;
  return Object.values(best).sort((a, b) => a.ageMinutes - b.ageMinutes).slice(0, 4);
}

async function isAlive(url) {
  try {
    const { code, json: ps } = await fetchJson(url + "/api/ps", {}, 9000);
    return code === 200 && ps && Array.isArray(ps.models) && ps.models.length > 0;
  } catch {
    return false;
  }
}

async function kernelStatus(acc) {
  const r = await fetchJson(
    `${API}/kernels/status?userName=${acc.user}&kernelSlug=${KERNEL_SLUG}`,
    { headers: { Authorization: "Bearer " + acc.key } },
    15000
  );
  return (r.json && r.json.status) || null;
}

async function wakeKernel(acc) {
  const notebook = fs.readFileSync(path.join(__dirname, "notebook.ipynb"), "utf8");
  const body = {
    slug: `${acc.user}/${KERNEL_SLUG}`,
    newTitle: KERNEL_TITLE,
    text: notebook,
    language: "python",
    kernelType: "notebook",
    isPrivate: true,
    enableGpu: true,
    enableInternet: true,
    kernelDataSources: acc.ds,
  };
  const r = await fetchJson(
    `${API}/kernels/push`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + acc.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    30000
  );
  if (r.json && (r.json.error || r.json.hasError)) {
    throw new Error("Kaggle push rejected: " + (r.json.error || "unknown"));
  }
  if (r.code >= 400 || !r.json) {
    throw new Error("Kaggle push HTTP " + r.code + " " + (r.text || ""));
  }
  return r.json;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }
  try {
    if (!ACCOUNTS.length) {
      return json(500, { status: "error", message: "KAGGLE_KEY env var not set in Netlify" });
    }

    // 1) any engine already alive?
    const links = await getLinks();
    const engines = [];
    for (const l of links) if (await isAlive(l.url)) engines.push(l);
    if (engines.length) {
      return json(200, { status: "alive", url: engines[0].url, engines, model: MODEL_NAME, ageMinutes: engines[0].ageMinutes });
    }

    // 2) wake the first account that can (skip dead quota / in-flight boots)
    const quotaErrors = [];
    for (const acc of ACCOUNTS) {
      let st = null;
      try { st = await kernelStatus(acc); } catch {}
      if (st === "queued") {
        return json(200, { status: "waking", etaMinutes: 10, reason: `version queued on ${acc.user}` });
      }
      if (links[0] && links[0].ageMinutes < 20 && st && st !== "complete" && st !== "error") {
        return json(200, { status: "waking", etaMinutes: Math.max(2, 10 - links[0].ageMinutes), reason: `boot in progress on ${acc.user}` });
      }
      try {
        await wakeKernel(acc);
        return json(200, { status: "waking", etaMinutes: 10, reason: `wake push sent to ${acc.user}` });
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (msg.includes("session count")) {
          return json(200, { status: "waking", etaMinutes: 10, reason: `session transition in progress on ${acc.user}` });
        }
        if (msg.includes("quota")) {
          quotaErrors.push(`${acc.user}: out of GPU quota`);
          continue; // try next account
        }
        throw e;
      }
    }
    return json(502, {
      status: "error",
      message: "all accounts out of GPU quota (" + quotaErrors.join("; ") + ") - weekly reset needed",
    });
  } catch (e) {
    return json(502, { status: "error", message: String((e && e.message) || e) });
  }
};
