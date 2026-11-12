import { CALM_RATE, schedulePhrases } from "./beats";

const MAX_BYTES = 4_000_000;

function isPrivateHost(host: string) {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1") return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  return false;
}

export function assertSafeAudioUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("audio_url is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("audio_url must be http(s)");
  }
  if (isPrivateHost(url.hostname)) throw new Error("audio_url host is not allowed");
  return url.toString();
}

export async function ingestAudioToR2(
  env: { AUDIO: R2Bucket },
  raw: string
): Promise<{ key: string; mime: string }> {
  const href = assertSafeAudioUrl(raw);
  const res = await fetch(href, { redirect: "follow", headers: { accept: "audio/*,*/*" } });
  if (!res.ok) throw new Error(`Could not fetch audio_url (${res.status})`);
  const mime = (res.headers.get("content-type") || "audio/mpeg").split(";")[0].trim().toLowerCase();
  if (mime && !mime.startsWith("audio/") && mime !== "application/octet-stream") {
    throw new Error(`audio_url is not audio (${mime})`);
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 64) throw new Error("audio_url file is empty");
  if (buf.byteLength > MAX_BYTES) throw new Error("audio_url is over 4MB");
  const key = `brought/${crypto.randomUUID()}.bin`;
  const contentType = mime.startsWith("audio/") ? mime : "audio/mpeg";
  await env.AUDIO.put(key, buf, { httpMetadata: { contentType } });
  return { key, mime: contentType };
}

function fourcc(view: DataView, offset: number): string {
  let s = "";
  for (let i = 0; i < 4; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

/** 16-bit PCM WAV. Returns null for mp3 or anything else so the caller can hand the bytes to the browser. */
export function decodeWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } | null {
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (fourcc(view, 0) !== "RIFF" || fourcc(view, 8) !== "WAVE") return null;
  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const id = fourcc(view, offset);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (id === "fmt " && size >= 16) {
      channels = view.getUint16(start + 2, true) || 1;
      sampleRate = view.getUint32(start + 4, true);
      bits = view.getUint16(start + 14, true);
    } else if (id === "data") {
      dataOffset = start;
      dataSize = size;
      break;
    }
    offset = start + size + (size % 2);
  }
  if (dataOffset < 0 || !sampleRate || bits !== 16 || channels < 1) return null;
  const frames = Math.floor(Math.min(dataSize, bytes.length - dataOffset) / (2 * channels));
  const samples = new Float32Array(frames);
  let p = dataOffset;
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      acc += view.getInt16(p, true) / 32768;
      p += 2;
    }
    samples[i] = acc / channels;
  }
  return { samples, sampleRate };
}

export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  const write = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const x = Math.max(-1, Math.min(1, samples[i] || 0));
    view.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    o += 2;
  }
  return new Uint8Array(buf);
}

export function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const outLen = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const out = new Float32Array(outLen);
  const ratio = fromRate / toRate;
  const last = samples.length - 1;
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.min(last, Math.floor(src));
    const i1 = Math.min(last, i0 + 1);
    const f = src - i0;
    out[i] = samples[i0] + (samples[i1] - samples[i0]) * f;
  }
  return out;
}

/** Drop leading/trailing silence so the attack, not the model's pad, lands on the kick. */
export function trimSilence(samples: Float32Array, sampleRate: number, threshold = 0.012): Float32Array {
  let i0 = -1;
  let i1 = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) > threshold) {
      i0 = i;
      break;
    }
  }
  if (i0 < 0) return new Float32Array(0);
  for (let i = samples.length - 1; i >= 0; i--) {
    if (Math.abs(samples[i]) > threshold) {
      i1 = i;
      break;
    }
  }
  const pre = Math.floor(sampleRate * 0.005);
  const post = Math.floor(sampleRate * 0.02);
  const start = Math.max(0, i0 - pre);
  const end = Math.min(samples.length, i1 + 1 + post);
  return samples.slice(start, end);
}

/** Same pitch-and-time change as playing slower. Rate under 1 lengthens the take. */
export function slowDown(samples: Float32Array, rate: number): Float32Array {
  if (samples.length === 0 || rate >= 0.999) return samples;
  const outLen = Math.max(1, Math.round(samples.length / rate));
  const out = new Float32Array(outLen);
  const last = samples.length - 1;
  for (let i = 0; i < outLen; i++) {
    const src = i * rate;
    const i0 = Math.min(last, Math.floor(src));
    const i1 = Math.min(last, i0 + 1);
    const f = src - i0;
    out[i] = samples[i0] + (samples[i1] - samples[i0]) * f;
  }
  return out;
}

export function preparePhrase(samples: Float32Array, sampleRate: number): Float32Array {
  return slowDown(trimSilence(samples, sampleRate), CALM_RATE);
}

export interface PackedPocket {
  pcm: Float32Array;
  phraseStarts: number[];
}

/** Lay already-calmed phrases onto beat 1 and beat 3. Sample 0 of the buffer is the downbeat. */
export function packPocket(
  phrases: Array<Float32Array | null>,
  sampleRate: number,
  bpm: number
): PackedPocket {
  const durations = phrases.map((p) => (p && p.length ? p.length / sampleRate : 0));
  const slots = schedulePhrases(durations, bpm);
  const strong = (60 / bpm) * 2;
  const last = slots[slots.length - 1];
  const totalSec = last ? last.start + last.slots * strong : 0;
  const total = Math.max(1, Math.ceil(totalSec * sampleRate));
  const pcm = new Float32Array(total);
  for (let i = 0; i < phrases.length; i++) {
    const phrase = phrases[i];
    if (!phrase || !phrase.length) continue;
    const at = Math.round(slots[i].start * sampleRate);
    const room = pcm.length - at;
    if (room <= 0) continue;
    pcm.set(phrase.subarray(0, Math.min(phrase.length, room)), at);
  }
  return { pcm, phraseStarts: slots.map((slot) => slot.start) };
}
