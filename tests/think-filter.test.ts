/**
 * The model's reasoning markers arrive INSIDE the content stream and can be
 * split across any two deltas, so this cannot be a regex over each chunk.
 * These tests drive the filter the way the real stream does: many small
 * deltas, with markers deliberately cut in half across a boundary.
 */
import { describe, expect, it } from "vitest";

import { createThinkFilter, stripThinkMarkers } from "@/lib/think-filter";

/* Built in pieces so no literal reasoning marker appears in this source; the
 * values are exactly the tags the model emits. */
const OPEN = "<th" + "ink>";
const CLOSE = "</th" + "ink>";

function feedChunked(text: string, size: number) {
  const f = createThinkFilter();
  let answer = "";
  let reasoning = "";
  for (let i = 0; i < text.length; i += size) {
    const out = f.feed(text.slice(i, i + size));
    answer += out.answer;
    reasoning += out.reasoning;
  }
  const tail = f.flush();
  return { answer: answer + tail.answer, reasoning: reasoning + tail.reasoning };
}

/** The whole thing in one piece, and then in every awkward chunk size. */
const SIZES = [1, 2, 3, 5, 7, 13, 64, 4096];

describe("think filter", () => {
  it("removes the exact leak measured live on engine C", () => {
    const leaked = `Paris is the capital of France. ${CLOSE}  Pa`;
    for (const size of SIZES) {
      const { answer } = feedChunked(leaked, size);
      expect(answer, `chunk=${size}`).toBe("Paris is the capital of France.   Pa");
      expect(answer).not.toContain("think>");
    }
  });

  it("drops the reasoning between a matched pair but keeps the answer", () => {
    const text = `The answer is 42.\n${OPEN}let me count 40 + 2${CLOSE}\nDone.`;
    for (const size of SIZES) {
      const { answer, reasoning } = feedChunked(text, size);
      expect(answer, `chunk=${size}`).toBe("The answer is 42.\n\nDone.");
      expect(reasoning).toBe("let me count 40 + 2");
    }
  });

  it("never emits the markers even when they straddle a chunk boundary", () => {
    const text = `before ${OPEN}hidden reasoning${CLOSE} after`;
    for (const size of SIZES) {
      const { answer } = feedChunked(text, size);
      expect(answer, `chunk=${size}`).toBe("before  after");
    }
  });

  it("releases held-back text that only looked like a partial marker", () => {
    /* A reply legitimately ending in a run of characters that could start a
       marker must not lose them at end of turn. */
    const text = "x < y and a < b";
    for (const size of SIZES) {
      expect(feedChunked(text, size).answer, `chunk=${size}`).toBe(text);
    }
    expect(feedChunked("trailing <", 1).answer).toBe("trailing <");
    expect(feedChunked("trailing <thi", 3).answer).toBe("trailing <thi");
  });

  it("handles back-to-back blocks", () => {
    const text = `A${OPEN}r1${CLOSE}B${OPEN}r2${CLOSE}C`;
    for (const size of SIZES) {
      expect(feedChunked(text, size).answer, `chunk=${size}`).toBe("ABC");
    }
  });

  it("keeps an unterminated block out of the answer", () => {
    const text = `Answer ${OPEN}reasoning that never ended`;
    for (const size of SIZES) {
      const { answer } = feedChunked(text, size);
      expect(answer, `chunk=${size}`).not.toContain("think>");
      expect(answer).not.toContain("reasoning that never ended");
    }
  });

  it("leaves ordinary prose containing the word think alone", () => {
    const text = "I think this is right, don't you think?";
    for (const size of SIZES) {
      expect(feedChunked(text, size).answer, `chunk=${size}`).toBe(text);
    }
  });

  it("does not lose answer text when a marker arrives alone in a delta", () => {
    const f = createThinkFilter();
    const parts = ["Hello ", OPEN, "secret plan", CLOSE, " world"];
    let answer = "";
    for (const p of parts) answer += f.feed(p).answer;
    answer += f.flush().answer;
    expect(answer).toBe("Hello  world");
  });

  it("one-shot form matches the streaming form", () => {
    const text = `a${OPEN}b${CLOSE}c`;
    const one = stripThinkMarkers(text);
    const stream = feedChunked(text, 1);
    expect(one.answer).toBe(stream.answer);
    expect(one.reasoning).toBe(stream.reasoning);
  });

  it("is a no-op on empty and marker-free input", () => {
    expect(createThinkFilter().feed("").answer).toBe("");
    expect(createThinkFilter().flush().answer).toBe("");
    expect(stripThinkMarkers("").answer).toBe("");
  });
});
