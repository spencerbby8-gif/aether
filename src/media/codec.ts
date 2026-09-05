/**
 * Isomorphic media codec — real pixels, real bytes, no DOM assumptions.
 * The software renderer and encoders run identically in the browser and
 * in Node tests, so mock providers produce genuine PNG/WAV artifacts.
 */

export interface PixelSurface {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA
}

export function createSurface(width: number, height: number): PixelSurface {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/* ---------------- deterministic RNG ---------------- */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/* ---------------- procedural generation ---------------- */

const PALETTES: Array<[number, number, number][]> = [
  [[20, 24, 34], [56, 46, 88], [226, 177, 97], [240, 230, 210]],
  [[12, 28, 30], [24, 84, 88], [95, 201, 142], [230, 245, 235]],
  [[32, 18, 24], [120, 46, 58], [224, 149, 90], [250, 235, 215]],
  [[16, 22, 40], [60, 80, 150], [134, 182, 232], [236, 244, 252]],
  [[28, 20, 40], [96, 60, 130], [211, 153, 232], [246, 240, 252]],
];

/** Deterministic abstract artwork from a seed — layered gradients + orbs. */
export function generateArt(surface: PixelSurface, seed: number, timeShift = 0): void {
  const { width, height, data } = surface;
  const rand = mulberry32(seed);
  const palette = PALETTES[seed % PALETTES.length];
  const [top, bottom, accent, light] = palette;

  const orbs = Array.from({ length: 7 }, () => ({
    x: rand() * width,
    y: rand() * height,
    r: width * (0.12 + rand() * 0.3),
    color: rand() > 0.4 ? accent : light,
    alpha: 0.18 + rand() * 0.4,
    drift: (rand() - 0.5) * 0.4 + timeShift * 0.15,
  }));

  for (let y = 0; y < height; y += 1) {
    const t = y / height;
    const br = top[0] + (bottom[0] - top[0]) * t;
    const bg = top[1] + (bottom[1] - top[1]) * t;
    const bb = top[2] + (bottom[2] - top[2]) * t;
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      let r = br;
      let g = bg;
      let b = bb;
      for (const orb of orbs) {
        const ox = orb.x + orb.drift * width;
        const dx = x - ox;
        const dy = y - orb.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < orb.r) {
          const falloff = 1 - dist / orb.r;
          const w = falloff * falloff * orb.alpha;
          r += (orb.color[0] - r) * w;
          g += (orb.color[1] - g) * w;
          b += (orb.color[2] - b) * w;
        }
      }
      const i = row + x * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
}

/* ---------------- editing ops (real pixel math) ---------------- */

export type EditOpName =
  | "brighten" | "darken" | "contrast-up" | "contrast-down" | "saturate" | "desaturate"
  | "grayscale" | "sepia" | "invert" | "warm" | "cool" | "blur";

export const EDIT_KEYWORDS: Array<[RegExp, EditOpName]> = [
  [/(bright|lighter)/i, "brighten"],
  [/(dark|dim)/i, "darken"],
  [/(more contrast|punch|pop)/i, "contrast-up"],
  [/(less contrast|soften|flat)/i, "contrast-down"],
  [/(more sat|vibran|colorful|punchy)/i, "saturate"],
  [/(desatur|mute|muted|faded)/i, "desaturate"],
  [/(grayscale|greyscale|black and white|b&w)/i, "grayscale"],
  [/(sepia|vintage|old[- ]?time|retro)/i, "sepia"],
  [/(invert|negative)/i, "invert"],
  [/(warm|warmer|golden|sunset)/i, "warm"],
  [/(cool|cooler|blue|icy|night)/i, "cool"],
  [/(blur|soft focus|smooth)/i, "blur"],
];

export function parseEditOps(instruction: string): EditOpName[] {
  const ops: EditOpName[] = [];
  for (const [pattern, op] of EDIT_KEYWORDS) {
    if (pattern.test(instruction)) ops.push(op);
  }
  return ops;
}

export function editKeywordsNote(): string {
  return EDIT_KEYWORDS.map(([, op]) => op).join(", ");
}

export function applyEditOp(surface: PixelSurface, op: EditOpName): PixelSurface {
  const { width, height } = surface;
  const src = surface.data;

  if (op === "blur") {
    const out = createSurface(width, height);
    const radius = 2;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -radius; dy <= radius; dy += 1) {
          for (let dx = -radius; dx <= radius; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const i = (ny * width + nx) * 4;
            r += src[i]; g += src[i + 1]; b += src[i + 2];
            n += 1;
          }
        }
        const o = (y * width + x) * 4;
        out.data[o] = r / n; out.data[o + 1] = g / n; out.data[o + 2] = b / n; out.data[o + 3] = 255;
      }
    }
    return out;
  }

  const out = createSurface(width, height);
  const dst = out.data;
  for (let i = 0; i < src.length; i += 4) {
    let r = src[i]; let g = src[i + 1]; let b = src[i + 2];
    switch (op) {
      case "brighten": r += 42; g += 42; b += 42; break;
      case "darken": r -= 42; g -= 42; b -= 42; break;
      case "contrast-up": r = (r - 128) * 1.3 + 128; g = (g - 128) * 1.3 + 128; b = (b - 128) * 1.3 + 128; break;
      case "contrast-down": r = (r - 128) * 0.75 + 128; g = (g - 128) * 0.75 + 128; b = (b - 128) * 0.75 + 128; break;
      case "saturate": {
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        r = gray + (r - gray) * 1.4; g = gray + (g - gray) * 1.4; b = gray + (b - gray) * 1.4;
        break;
      }
      case "desaturate": {
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        r = gray + (r - gray) * 0.4; g = gray + (g - gray) * 0.4; b = gray + (b - gray) * 0.4;
        break;
      }
      case "grayscale": {
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        r = gray; g = gray; b = gray;
        break;
      }
      case "sepia": {
        const nr = 0.393 * r + 0.769 * g + 0.189 * b;
        const ng = 0.349 * r + 0.686 * g + 0.168 * b;
        const nb = 0.272 * r + 0.534 * g + 0.131 * b;
        r = nr; g = ng; b = nb;
        break;
      }
      case "invert": r = 255 - r; g = 255 - g; b = 255 - b; break;
      case "warm": r += 26; b -= 20; break;
      case "cool": b += 26; r -= 18; break;
      default: break;
    }
    dst[i] = Math.max(0, Math.min(255, r));
    dst[i + 1] = Math.max(0, Math.min(255, g));
    dst[i + 2] = Math.max(0, Math.min(255, b));
    dst[i + 3] = 255;
  }
  return out;
}

/** Auto-contrast stretch + gentle saturation boost — a real enhancement pass. */
export function enhance(surface: PixelSurface): PixelSurface {
  const src = surface.data;
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < src.length; i += 4) {
    const luma = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
    if (luma < lo) lo = luma;
    if (luma > hi) hi = luma;
  }
  const range = Math.max(1, hi - lo);
  const out = createSurface(surface.width, surface.height);
  const dst = out.data;
  for (let i = 0; i < src.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      const stretched = ((src[i + c] - lo) / range) * 255;
      const gray = 0.299 * dst[i] + 0.587 * dst[i + 1] + 0.114 * dst[i + 2];
      dst[i + c] = Math.max(0, Math.min(255, gray + (stretched - gray) * 1.12));
    }
    dst[i + 3] = 255;
  }
  return out;
}

/** Real bilinear 2× resample. */
export function upscale(surface: PixelSurface, factor = 2): PixelSurface {
  const { width, height, data } = surface;
  const nw = Math.round(width * factor);
  const nh = Math.round(height * factor);
  const out = createSurface(nw, nh);
  const sample = (x: number, y: number): [number, number, number] => {
    const cx = Math.max(0, Math.min(width - 1, x));
    const cy = Math.max(0, Math.min(height - 1, y));
    const x0 = Math.floor(cx); const y0 = Math.floor(cy);
    const x1 = Math.min(width - 1, x0 + 1); const y1 = Math.min(height - 1, y0 + 1);
    const fx = cx - x0; const fy = cy - y0;
    const at = (xx: number, yy: number, c: number) => data[(yy * width + xx) * 4 + c];
    const blend = (c: number) => {
      const top = at(x0, y0, c) * (1 - fx) + at(x1, y0, c) * fx;
      const bottom = at(x0, y1, c) * (1 - fx) + at(x1, y1, c) * fx;
      return top * (1 - fy) + bottom * fy;
    };
    return [blend(0), blend(1), blend(2)];
  };
  for (let y = 0; y < nh; y += 1) {
    for (let x = 0; x < nw; x += 1) {
      const [r, g, b] = sample(x / factor, y / factor);
      const i = (y * nw + x) * 4;
      out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b; out.data[i + 3] = 255;
    }
  }
  return out;
}

/* ---------------- PNG encoder (isomorphic) ---------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const length = new DataView(new ArrayBuffer(4));
  length.setUint32(0, payload.length);
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + payload.length);
  body.set(typeBytes, 0);
  body.set(payload, typeBytes.length);
  const crc = new DataView(new ArrayBuffer(4));
  crc.setUint32(0, crc32(body));
  const chunk = new Uint8Array(4 + body.length + 4);
  chunk.set(new Uint8Array(length.buffer), 0);
  chunk.set(body, 4);
  chunk.set(new Uint8Array(crc.buffer), 4 + body.length);
  return chunk;
}

/**
 * Encode RGBA pixels as a real PNG.
 * The deflate implementation is injected so this module stays free of
 * node-only imports (tests pass zlib.deflateSync; the browser uses canvas).
 */
export function encodePNGWith(
  surface: PixelSurface,
  deflate: (input: Uint8Array) => Uint8Array,
): Uint8Array {
  const { width, height, data } = surface;
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const compressed = deflate(raw);

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function pngSignatureValid(bytes: Uint8Array): boolean {
  return (
    bytes.length > 24 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52
  );
}

/* ---------------- WAV codec (real PCM16 mono) ---------------- */

export function encodeWav(samples: Float32Array, sampleRate = 16_000): Uint8Array {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped * 32767, true);
  }
  return new Uint8Array(buffer);
}

export interface WavData {
  sampleRate: number;
  samples: Float32Array;
}

/** Decode PCM16 mono WAV back to samples (for trim operations). */
export function decodeWav(bytes: Uint8Array): WavData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readString = (offset: number, length: number) =>
    Array.from({ length }, (_, i) => String.fromCharCode(bytes[offset + i])).join("");
  if (readString(0, 4) !== "RIFF" || readString(8, 4) !== "WAVE") {
    throw new Error("Not a WAV file.");
  }
  let offset = 12;
  let sampleRate = 16_000;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const chunkId = readString(offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === "fmt ") sampleRate = view.getUint32(offset + 12, true);
    if (chunkId === "data") {
      dataOffset = offset + 8;
      dataSize = chunkSize;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (dataOffset < 0) throw new Error("WAV has no data chunk.");
  const samples = new Float32Array(dataSize / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(dataOffset + i * 2, true) / 32768;
  }
  return { sampleRate, samples };
}

/** Deterministic melodic synthesis — real audio, clearly a mock composer. */
export function synthesizeAudio(prompt: string, durationMs = 3000): { samples: Float32Array; sampleRate: number } {
  const sampleRate = 16_000;
  const seed = hashSeed(prompt);
  const rand = mulberry32(seed);
  const scale = [220, 246.94, 277.18, 329.63, 369.99, 440, 493.88, 554.37];
  const total = Math.floor((durationMs / 1000) * sampleRate);
  const samples = new Float32Array(total);
  const noteLength = Math.floor(sampleRate * 0.34);
  let phase = 0;
  for (let start = 0; start < total; start += noteLength) {
    const freq = scale[Math.floor(rand() * scale.length)] * (rand() > 0.7 ? 0.5 : 1);
    const amp = 0.16 + rand() * 0.1;
    for (let i = 0; i < noteLength && start + i < total; i += 1) {
      const envelope = Math.min(1, i / 900) * Math.min(1, (noteLength - i) / 1600);
      phase += (2 * Math.PI * freq) / sampleRate;
      samples[start + i] +=
        envelope * amp * (Math.sin(phase) + 0.3 * Math.sin(phase * 2) + 0.12 * Math.sin(phase * 3.01));
    }
  }
  return { samples, sampleRate };
}
