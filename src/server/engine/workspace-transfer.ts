/**
 * Move a conversation's workspace from the engine it was running on to the
 * engine taking over.
 *
 * A workspace lives on the engine's own disk under /kaggle/working/sessions.
 * Failover that only swaps the URL therefore hands the new engine a task that
 * believes it created files which are not there -- it goes on referring to
 * them, and every command that touches them fails. Exporting the archive from
 * the old engine and restoring it on the new one is what makes a mid-task
 * switch a continuation instead of a restart.
 *
 * Both hops are keyed. The transfer is best-effort by design: if the old engine
 * is already gone there is nothing to export, and the task still continues with
 * its message history and plan -- only the files are missing. That is reported
 * rather than hidden.
 */

const OFF_HEADER = "X-Engine-Key";
const TIMEOUT_MS = 20_000;
const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type TransferOutcome =
  | { status: "restored"; files: number }
  | { status: "nothing-to-transfer" }
  | { status: "source-gone" }
  | { status: "failed"; detail: string };

/** Export `session`'s workspace from `fromUrl` and restore it on `toUrl`. */
export async function transferWorkspace(
  fromUrl: string,
  toUrl: string,
  session: string,
  offKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TransferOutcome> {
  if (!SESSION_RE.test(session)) {
    return { status: "failed", detail: "invalid session id" };
  }
  let zip: ArrayBuffer;
  try {
    const response = await fetchImpl(
      `${fromUrl.replace(/\/$/, "")}/workspace/${session}.zip`,
      { headers: { [OFF_HEADER]: offKey }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (response.status === 404) return { status: "nothing-to-transfer" };
    if (!response.ok) return { status: "source-gone" };
    zip = await response.arrayBuffer();
  } catch (error) {
    /* The engine being failed away from is very often the thing that broke. */
    return { status: "source-gone" };
  }
  if (zip.byteLength === 0) return { status: "nothing-to-transfer" };

  try {
    const response = await fetchImpl(
      `${toUrl.replace(/\/$/, "")}/workspace/${session}`,
      {
        method: "POST",
        headers: { [OFF_HEADER]: offKey, "Content-Type": "application/zip" },
        body: zip,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      return { status: "failed", detail: `restore HTTP ${response.status}: ${text.slice(0, 160)}` };
    }
    let files = 0;
    try {
      files = Number((JSON.parse(text) as { files?: number }).files ?? 0);
    } catch {
      /* a non-JSON 200 still counts as restored */
    }
    return { status: "restored", files };
  } catch (error) {
    return { status: "failed", detail: `restore request failed: ${String(error).slice(0, 160)}` };
  }
}
