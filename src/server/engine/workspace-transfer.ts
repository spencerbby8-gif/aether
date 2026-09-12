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
  | { status: "restored"; files: number; fromCheckpoint?: boolean }
  | { status: "nothing-to-transfer" }
  | { status: "source-gone" }
  | { status: "failed"; detail: string };

/**
 * Fetch the checkpoint the CLIENT should hold.
 *
 * The engine writes a checkpoint archive after every tool step, but it writes
 * it to its own disk behind its own tunnel -- so once the kernel dies the
 * checkpoint dies with it, and reading it back from the dead engine is exactly
 * as impossible as reading the workspace was. The only party guaranteed to
 * outlive the engine is the client, so the client is the one that has to hold
 * the copy.
 *
 * Call this after each tool_result event while the engine is still answering.
 * It is small (one zip of the session workspace) and it is what turns "the
 * engine died" from "the work is gone" into "resume from the last step".
 */
export async function fetchCheckpoint(
  engineUrl: string,
  session: string,
  offKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ArrayBuffer | null> {
  if (!SESSION_RE.test(session)) return null;
  try {
    const response = await fetchImpl(
      `${engineUrl.replace(/\/$/, "")}/checkpoint/${session}.zip`,
      { headers: { [OFF_HEADER]: offKey }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!response.ok) return null;
    const buf = await response.arrayBuffer();
    return buf.byteLength > 0 ? buf : null;
  } catch {
    return null;
  }
}

/** Export `session`'s workspace from `fromUrl` and restore it on `toUrl`. */
export async function transferWorkspace(
  fromUrl: string,
  toUrl: string,
  session: string,
  offKey: string,
  fetchImpl: typeof fetch = fetch,
  heldCheckpoint?: ArrayBuffer | null,
): Promise<TransferOutcome> {
  if (!SESSION_RE.test(session)) {
    return { status: "failed", detail: "invalid session id" };
  }
  let zip: ArrayBuffer;
  /*
   * Try the live workspace first, then the checkpoint.
   *
   * The order matters and the second attempt is the one that usually saves the
   * task. Measured failure: an engine killed mid-task could not be asked for
   * its workspace at all -- /off had already taken the kernel down, so
   * /workspace/<id>.zip returned 530 and every file the task had produced was
   * unrecoverable. A client cannot read work out of a process that no longer
   * exists.
   *
   * The engine now writes a checkpoint archive after every tool step, into the
   * directory its tunnel serves, so the last completed step is retrievable even
   * once the kernel is gone. That is the difference between "continue from the
   * last verified step" and "start over".
   */
  const base = fromUrl.replace(/\/$/, "");
  const attempts = [
    { path: `/workspace/${session}.zip`, kind: "live" as const },
    { path: `/checkpoint/${session}.zip`, kind: "checkpoint" as const },
  ];
  let lastStatus: number | null = null;
  let fetched: ArrayBuffer | null = null;
  let fromCheckpoint = false;
  for (const attempt of attempts) {
    try {
      const response = await fetchImpl(base + attempt.path, {
        headers: { [OFF_HEADER]: offKey },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      lastStatus = response.status;
      if (response.status === 404) continue;
      if (!response.ok) continue;
      fetched = await response.arrayBuffer();
      fromCheckpoint = attempt.kind === "checkpoint";
      break;
    } catch {
      /* The engine being failed away from is often the thing that broke; the
         next attempt is the point of having two. */
      continue;
    }
  }
  if (!fetched && heldCheckpoint && heldCheckpoint.byteLength > 0) {
    /* The engine is gone and neither of its endpoints answered, but the client
       was pulling checkpoints while it lived. This is the path that actually
       recovers a task whose engine died. */
    fetched = heldCheckpoint;
    fromCheckpoint = true;
  }
  if (!fetched) {
    return { status: lastStatus === 404 ? "nothing-to-transfer" : "source-gone" };
  }
  zip = fetched;
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
    return { status: "restored", files, fromCheckpoint };
  } catch (error) {
    return { status: "failed", detail: `restore request failed: ${String(error).slice(0, 160)}` };
  }
}
