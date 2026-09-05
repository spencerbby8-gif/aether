import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  applyEditOp,
  createSurface,
  decodeWav,
  encodePNGWith,
  encodeWav,
  enhance,
  generateArt,
  hashSeed,
  parseEditOps,
  pngSignatureValid,
  synthesizeAudio,
  upscale,
} from "@/media/codec";

describe("codec — deterministic generation", () => {
  it("hashes prompts to stable seeds", () => {
    expect(hashSeed("aurora")).toBe(hashSeed("aurora"));
    expect(hashSeed("aurora")).not.toBe(hashSeed("sunset"));
  });

  it("renders real, non-uniform artwork with full alpha", () => {
    const surface = createSurface(64, 64);
    generateArt(surface, hashSeed("ember dusk"));
    const seen = new Set<number>();
    for (let i = 0; i < surface.data.length; i += 4) {
      seen.add(surface.data[i]);
      expect(surface.data[i + 3]).toBe(255);
      if (seen.size > 24) break;
    }
    expect(seen.size).toBeGreaterThan(24);
  });

  it("encodes a valid PNG from raw pixels", () => {
    const surface = createSurface(16, 16);
    generateArt(surface, 42);
    const png = encodePNGWith(surface, (input) => new Uint8Array(deflateSync(Buffer.from(input))));
    expect(pngSignatureValid(png)).toBe(true);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(view.getUint32(16)).toBe(16); // width in IHDR
    expect(view.getUint32(20)).toBe(16); // height in IHDR
  });
});

describe("codec — real editing math", () => {
  it("parses natural-language edit instructions", () => {
    expect(parseEditOps("make it grayscale and darker")).toEqual(["darken", "grayscale"]);
    expect(parseEditOps("warm golden look please")).toEqual(["warm"]);
    expect(parseEditOps("zzz nothing matches")).toEqual([]);
  });

  it("grayscale collapses channels; invert round-trips", () => {
    const surface = createSurface(4, 4);
    generateArt(surface, 7);
    const gray = applyEditOp(surface, "grayscale");
    for (let i = 0; i < gray.data.length; i += 4) {
      expect(gray.data[i]).toBe(gray.data[i + 1]);
      expect(gray.data[i + 1]).toBe(gray.data[i + 2]);
    }
    const inverted = applyEditOp(surface, "invert");
    const restored = applyEditOp(inverted, "invert");
    for (let i = 0; i < restored.data.length; i += 4) {
      expect(Math.abs(restored.data[i] - surface.data[i])).toBeLessThanOrEqual(1);
    }
  });

  it("enhance stretches contrast", () => {
    const surface = createSurface(8, 8);
    generateArt(surface, 99);
    const enhanced = enhance(surface);
    expect(enhanced.data.length).toBe(surface.data.length);
    expect(Array.from(enhanced.data)).not.toEqual(Array.from(surface.data));
  });

  it("upscale really resamples to 2×", () => {
    const surface = createSurface(8, 8);
    generateArt(surface, 5);
    const big = upscale(surface, 2);
    expect(big.width).toBe(16);
    expect(big.height).toBe(16);
    /* Corners must approximate the source corners (bilinear boundary). */
    const srcCorner = [surface.data[0], surface.data[1], surface.data[2]];
    const dstCorner = [big.data[0], big.data[1], big.data[2]];
    for (let c = 0; c < 3; c += 1) expect(Math.abs(srcCorner[c] - dstCorner[c])).toBeLessThan(40);
  });
});

describe("codec — real audio", () => {
  it("synthesizes deterministic waveforms", () => {
    const a = synthesizeAudio("calm pad", 500);
    const b = synthesizeAudio("calm pad", 500);
    const c = synthesizeAudio("bright arps", 500);
    expect(a.samples.length).toBe(b.samples.length);
    expect(a.samples[1000]).toBeCloseTo(b.samples[1000], 5);
    expect(a.samples[1000]).not.toBeCloseTo(c.samples[1000], 5);
  });

  it("round-trips WAV encode/decode", () => {
    const { samples, sampleRate } = synthesizeAudio("roundtrip", 400);
    const bytes = encodeWav(samples, sampleRate);
    const decoded = decodeWav(bytes);
    expect(decoded.sampleRate).toBe(sampleRate);
    expect(decoded.samples.length).toBe(samples.length);
    expect(decoded.samples[500]).toBeCloseTo(samples[500], 2);
  });
});
