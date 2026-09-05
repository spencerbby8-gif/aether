// ============================================================================
// NEXUS engine-off v2 — ONE BUTTON KILLS ALL ENGINES
// Finds EVERY alive engine on the beacons and shuts each down (quota saved).
// UI calls: GET|POST /.netlify/functions/engine-off
// Env var:  ENGINE_OFF_KEY (same secret baked in the engine notebook)
// Response: { status:"off", killed:[{url,result}...] }  result: "shutdown" | "unreachable" | "already off"
//            403 if the engine rejects the key (wrong ENGINE_OFF_KEY)
// The engines also auto-shutdown after 60 min idle (v23) — this button is instant.
// ============================================================================

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

async function fetchT(url, opts = {}, ms = 12000) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
  const text = await r.text();
  try { return { code: r.status, json: JSON.parse(text) }; } catch { return { code: r.status, json: null, text }; }
}

async function getLinks() {
  const out = [];
  const jobs = await Promise.allSettled([
    fetchT("https://REMOVED_WEBHOOK_TOKEN/requests?sorting=newest", {}, 15000),
    fetch("https://ntfy.sh/REMOVED_BEACON_TOPIC/json?poll=1&since=12h", { signal: AbortSignal.timeout(15000) }).then((r) => r.text()),
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
  const best = {};
  for (const l of out) if (!best[l.url] || l.ageMinutes < best[l.url].ageMinutes) best[l.url] = l;
  return Object.values(best).sort((a, b) => a.ageMinutes - b.ageMinutes).slice(0, 6);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }
  try {
    const KEY = process.env.ENGINE_OFF_KEY;
    if (!KEY) return json(500, { status: "error", message: "ENGINE_OFF_KEY env var not set in Netlify" });

    const links = (await getLinks()).filter((l) => l.ageMinutes < 360); // current sessions only
    if (!links.length) {
      return json(200, { status: "off", killed: [], message: "no running engines found - all engines already off" });
    }

    const killed = [];
    let forbidden = false;
    for (const l of links) {
      try {
        const r = await fetchT(l.url + "/off", {
          method: "POST",
          headers: { "X-Engine-Key": KEY, "Content-Type": "application/json" },
        }, 10000);
        if (r.code === 200) killed.push({ url: l.url, result: "shutdown" });
        else if (r.code === 403) { forbidden = true; killed.push({ url: l.url, result: "rejected-key" }); }
        else killed.push({ url: l.url, result: "unreachable" });
      } catch {
        killed.push({ url: l.url, result: "already off" });
      }
    }
    const anyShutdown = killed.some((k) => k.result === "shutdown");
    return json(anyShutdown ? 200 : forbidden ? 403 : 200, {
      status: "off",
      killed,
      message: anyShutdown
        ? killed.filter((k) => k.result === "shutdown").length + " engine(s) shut down - quota saved"
        : "no running engine reached - all already off",
    });
  } catch (e) {
    return json(502, { status: "error", message: String((e && e.message) || e) });
  }
};
