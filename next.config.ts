import type { NextConfig } from "next";

/**
 * FIX (audit §3.3 / A6): the rewrites that mapped /.netlify/functions/* onto the
 * Next API routes are gone, along with the legacy handlers they pointed at.
 *
 * There were three wake/off implementations in this repo (manager.ts+kaggle.ts,
 * resolve.ts, and netlify/functions/*.js) and they had already drifted — that is
 * how the shutdown path ended up calling /api/off while the engine only serves
 * /off. With the rewrites present, Netlify ran the *function* and local dev ran
 * the *route*: two different behaviours from one commit. Now there is exactly one
 * control plane — the API routes — and it behaves identically everywhere.
 */
const nextConfig: NextConfig = {};

export default nextConfig;
