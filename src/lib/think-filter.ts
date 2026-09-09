/**
 * Stream-safe removal of the model's reasoning markers from answer content.
 *
 * WHY THIS EXISTS. The engines are Qwen reasoning builds. When a turn runs with
 * thinking enabled the model emits `<think>...
</think>

` *inside* the content
 * stream. Measured live on engine C, a plain "capital of France" reply arrived
 * as:
 *
 *     'Paris is the capital of France. </think>  Pa...'
 *
 * Nothing in the app or the engine handled it, so the marker was rendered
 * verbatim in the user's chat — and the reasoning between a pair of markers is
 * not part of the answer either.
 *
 * WHY IT IS STATEFUL. Content arrives in deltas, and a marker can be split
 * across any two of them (`... France. </thi` + `nk> ...`). A per-delta regex
 * therefore cannot work: it would either miss the split marker or hold back
 * ordinary text forever. This holds back at most `marker.length - 1` characters
 * while a partial marker is still possible, and returns them on flush.
 *
 * WHAT IT NEVER DOES. It does not summarise, reword or drop answer text. Only
 * the two markers and the reasoning between a matched pair are removed, and
 * that reasoning is handed to the caller so it can be shown in the reasoning
 * panel instead of being thrown away.
 */

/* Built in pieces so no literal reasoning marker sits in a string literal in
 * this file. The values are exactly the tags the model emits. */
const OPEN = "<th" + "ink>";
const CLOSE = "</th" + "ink>";

export interface ThinkChunk {
  /** Answer text, safe to append to the visible message. */
  answer: string;
  /** Reasoning text recovered from inside a think block, if any. */
  reasoning: string;
}

export interface ThinkFilter {
  /** Feed one content delta. Returns what is safe to show or record now. */
  feed(delta: string): ThinkChunk;
  /**
   * End of turn. Releases anything that was held back on the chance it was a
   * partial marker. Text still inside an unterminated think block stays
   * withheld: it is reasoning, and an unterminated block means the turn ended
   * mid-reasoning.
   */
  flush(): ThinkChunk;
}

const EMPTY: ThinkChunk = { answer: "", reasoning: "" };

export function createThinkFilter(): ThinkFilter {
  let buf = "";
  let inThink = false;

  const feed = (delta: string): ThinkChunk => {
    if (!delta) return EMPTY;
    buf += delta;
    let answer = "";
    let reasoning = "";

    for (;;) {
      if (inThink) {
        const k = buf.indexOf(CLOSE);
        if (k < 0) {
          /* Still reasoning. Keep only a tail that could still be completing
             the closing marker; the rest is confirmed reasoning. */
          const keep = Math.min(buf.length, CLOSE.length - 1);
          reasoning += buf.slice(0, buf.length - keep);
          buf = buf.slice(buf.length - keep);
          break;
        }
        reasoning += buf.slice(0, k);
        buf = buf.slice(k + CLOSE.length);
        inThink = false;
        continue;
      }

      /* Not inside a block. Either marker can turn up: an opener starts a
         block, and a closer with no opener is the case actually measured live
         on engine C — the model ended its reasoning and emitted only the
         closing tag. Both are removed; neither may reach the answer. */
      const ko = buf.indexOf(OPEN);
      const kc = buf.indexOf(CLOSE);
      if (ko < 0 && kc < 0) {
        /* No marker. Emit everything except a tail that could still be
           completing either marker. */
        const keep = Math.min(buf.length, Math.max(OPEN.length, CLOSE.length) - 1);
        answer += buf.slice(0, buf.length - keep);
        buf = buf.slice(buf.length - keep);
        break;
      }
      if (kc >= 0 && (ko < 0 || kc < ko)) {
        /* Stray closer: drop the tag, keep the text on both sides. */
        answer += buf.slice(0, kc);
        buf = buf.slice(kc + CLOSE.length);
        continue;
      }
      answer += buf.slice(0, ko);
      buf = buf.slice(ko + OPEN.length);
      inThink = true;
    }

    return answer || reasoning ? { answer, reasoning } : EMPTY;
  };

  const flush = (): ThinkChunk => {
    const held = buf;
    buf = "";
    if (inThink) {
      inThink = false;
      /* An unterminated block is reasoning all the way to the end. */
      return held ? { answer: "", reasoning: held } : EMPTY;
    }
    return held ? { answer: held, reasoning: "" } : EMPTY;
  };

  return { feed, flush };
}

/**
 * One-shot form for text that is already complete (stored history, exports,
 * the Android-side normaliser's equivalent). Never withholds anything.
 */
export function stripThinkMarkers(text: string): { answer: string; reasoning: string } {
  const f = createThinkFilter();
  const a = f.feed(text);
  const b = f.flush();
  return { answer: a.answer + b.answer, reasoning: a.reasoning + b.reasoning };
}
