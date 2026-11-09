// Edge Function: google-drive-token
//
// Exchanges a Google Sign-In server auth code for a refresh token, keeps that
// refresh token server-side, and hands the app short-lived access tokens.
//
// Deliberate properties:
//   * POST only.
//   * The user is derived from the caller's Supabase JWT, never from the body.
//   * No token, code or secret is ever logged or returned in an error.
//   * The refresh token never leaves this function.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("GOOGLE_WEB_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("GOOGLE_WEB_CLIENT_SECRET") ?? "";
const TABLE = `${SUPABASE_URL}/rest/v1/google_drive_credentials`;
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";

const JSON_HEADERS = { "Content-Type": "application/json" };

function fail(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });
}

/** Verify the caller and return their Supabase user id, or null. */
async function caller(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: SERVICE_ROLE },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return typeof user?.id === "string" ? user.id : null;
}

async function storeRefreshToken(userId: string, refreshToken: string, scope: string) {
  const res = await fetch(`${TABLE}?on_conflict=user_id`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      user_id: userId,
      refresh_token: refreshToken,
      scope,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error("store_failed");
}

async function readRefreshToken(userId: string): Promise<{ refresh_token: string; scope: string } | null> {
  const res = await fetch(`${TABLE}?user_id=eq.${encodeURIComponent(userId)}&select=refresh_token,scope`, {
    headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function deleteRow(userId: string) {
  await fetch(`${TABLE}?user_id=eq.${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
  });
}

/** Google token endpoint. Any failure becomes a short code, never the raw body. */
async function googleToken(params: Record<string, string>): Promise<
  { ok: true; access_token: string; expires_in: number; scope: string; refresh_token?: string } |
  { ok: false; code: string }
> {
  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
  });
  if (!res.ok) {
    const body = await res.text();
    // Surface only Google's error CODE (e.g. invalid_grant), never the payload.
    let code = "google_rejected";
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed?.error === "string") code = parsed.error.slice(0, 40);
    } catch { /* keep the generic code */ }
    return { ok: false, code };
  }
  const json = await res.json();
  if (typeof json?.access_token !== "string") return { ok: false, code: "google_no_token" };
  return {
    ok: true,
    access_token: json.access_token,
    expires_in: Number(json.expires_in) || 3600,
    scope: typeof json.scope === "string" ? json.scope : "",
    refresh_token: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return fail(405, "method_not_allowed");

  // Authenticate BEFORE revealing anything about configuration: an anonymous
  // caller must not be able to tell whether Drive is set up on this project.
  const userId = await caller(req);
  if (!userId) return fail(401, "not_signed_in");
  if (!CLIENT_ID || !CLIENT_SECRET) return fail(503, "drive_not_configured");

  let action = "";
  let code = "";
  try {
    const body = await req.json();
    action = typeof body?.action === "string" ? body.action : "";
    code = typeof body?.code === "string" ? body.code : "";
  } catch { return fail(400, "bad_request"); }

  if (action === "connect") {
    if (!code || code.length > 4096) return fail(400, "bad_code");
    // No redirect_uri: server auth codes from the Play-services sheet are not
    // bound to one, and sending a wrong value breaks the exchange.
    const result = await googleToken({ grant_type: "authorization_code", code });
    if (!result.ok) return fail(400, result.code);
    if (!result.refresh_token) {
      // Without a refresh token this link would die in an hour. Say so instead
      // of pretending the backup is durable.
      return fail(409, "no_refresh_token");
    }
    try { await storeRefreshToken(userId, result.refresh_token, result.scope); }
    catch { return fail(500, "store_failed"); }
    return new Response(JSON.stringify({
      access_token: result.access_token, expires_in: result.expires_in, scope: result.scope,
    }), { headers: JSON_HEADERS });
  }

  if (action === "access") {
    const row = await readRefreshToken(userId);
    if (!row?.refresh_token) return fail(404, "not_connected");
    const result = await googleToken({ grant_type: "refresh_token", refresh_token: row.refresh_token });
    if (!result.ok) {
      // A revoked or expired grant is not recoverable by retrying.
      if (result.code === "invalid_grant") { await deleteRow(userId); return fail(403, "reconnect_required"); }
      return fail(502, result.code);
    }
    if (result.refresh_token) {
      // Google occasionally rotates the refresh token; keep the newest one.
      try { await storeRefreshToken(userId, result.refresh_token, result.scope || row.scope || ""); }
      catch { /* the access token still works for this call */ }
    }
    return new Response(JSON.stringify({
      access_token: result.access_token, expires_in: result.expires_in, scope: result.scope,
    }), { headers: JSON_HEADERS });
  }

  if (action === "disconnect") {
    const row = await readRefreshToken(userId);
    if (row?.refresh_token) {
      // Revoke first: a failed local delete must not leave live access behind.
      await fetch(`${GOOGLE_REVOKE}?token=${encodeURIComponent(row.refresh_token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }).catch(() => { /* deleting the row is still the right end state */ });
    }
    await deleteRow(userId);
    return new Response(JSON.stringify({ disconnected: true }), { headers: JSON_HEADERS });
  }

  return fail(400, "unknown_action");
});
