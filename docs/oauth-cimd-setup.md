# Vercel MCP OAuth with CIMD

Vercel supports OAuth Client ID Metadata Documents (CIMD). This avoids embedding a client secret in the Android APK and avoids Vercel's reviewed-client registration allowlist.

1. Copy `public/oauth/aether-mcp-client.json` to an HTTPS static host you control.
2. Replace `client_id` in that JSON with the exact final HTTPS URL of the file. The URL and value must match.
3. Serve the file as `application/json` without authentication or redirects. Do not put tokens in it.
4. In Aether, open **Settings → Conversation & Agent → Connectors & MCP → Vercel**.
5. Paste the exact HTTPS file URL into **OAuth client metadata URL**, review the read/write/execute grants, and tap **Connect securely with OAuth**.
6. Approve the Vercel account/team permissions in the browser. Aether shows Connected only after the callback state is validated and the authorization code is exchanged for a token.

If no metadata URL is supplied, Aether tries dynamic registration. Vercel rejected the custom-scheme dynamic-registration attempt with `invalid_redirect_uri` during verification, so CIMD or a personal access token is the working setup path. No Vercel account connection is claimed until a real user completes OAuth or supplies a token and the MCP `initialize`/`tools/list` exchange succeeds.
