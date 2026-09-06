/**
 * The single user-facing version string.
 *
 * FIX (audit §4.8 / A9): the sidebar used to hardcode "Phase 5", an internal
 * roadmap label that had long stopped matching reality. This is the app version
 * instead, and tests/version.test.ts pins it to package.json so the two cannot
 * drift apart the way the hardcoded badge did.
 */
export const APP_VERSION = "1.0.0";
