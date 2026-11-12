/**
 * Text-to-speech via Cloudflare Workers AI (Deepgram Aura-2).
 *
 * The model input is speaker, encoding, container, sample_rate, bit_rate, and
 * text — there is no speed or style field on `@cf/deepgram/aura-2-en`. A whole
 * verse in one call is one breathless take, and the deck used to speed that
 * blob up to chase the bar. Delivery is calmer because:
 *   - each line is its own take (the model doesn't wind up across the verse),
 *   - a missing speaker falls back to Odysseus (Deepgram: calm, smooth),
 *   - phrases are time-fit onto the kick (beat 1 and 3) at CALM_RATE < 1.
 * The verse text is not rewritten. A trailing period is only added on the
 * synth request when a line has no ending punctuation, so the contour falls.
 */

import { decodeWav, encodeWav, packPocket, preparePhrase, resample } from "./audio";
import { CALM_RATE, sanitizeBpm, verseLines } from "./beats";

export interface Env {
  AI: Ai;
  AUDIO: R2Bucket;
  DB: D1Database;
}

/** Deepgram marks Odysseus "Calm, Smooth, Comfortable, Professional". */
export const CALM_SPEAKER = "odysseus";

const SPEAKERS = new Set<string>([
  "amalthea",
  "andromeda",
  "apollo",
  "arcas",
  "aries",
  "asteria",
  "athena",
  "atlas",
  "aurora",
  "callista",
  "cora",
  "cordelia",
  "delia",
  "draco",
  "electra",
  "harmonia",
  "helena",
  "hera",
  "hermes",
  "hyperion",
  "iris",
  "janus",
  "juno",
  "jupiter",
  "luna",
  "mars",
  "minerva",
  "neptune",
  "odysseus",
  "ophelia",
  "orion",
  "orpheus",
  "pandora",
  "phoebe",
  "pluto",
  "saturn",
  "thalia",
  "theia",
  "vesta",
  "zeus",
]);

export function resolveSpeaker(voiceId?: string | null): Ai_Cf_Deepgram_Aura_2_En_Input["speaker"] {
  const id = (voiceId || "").toLowerCase().trim();
  if (SPEAKERS.has(id)) return id as Ai_Cf_Deepgram_Aura_2_En_Input["speaker"];
  return CALM_SPEAKER;
}

function spokenLine(line: string): string {
  const t = line.trim();
  if (/[.!?,;:]$/.test(t)) return t;
  return t + ".";
}

async function readAudioBytes(result: unknown): Promise<Uint8Array> {
  const audioBuffer =
    result instanceof ArrayBuffer
      ? result
      : await new Response(result as BodyInit).arrayBuffer();
  return new Uint8Array(audioBuffer);
}

async function synthLine(env: Env, text: string, speaker: Ai_Cf_Deepgram_Aura_2_En_Input["speaker"]): Promise<Uint8Array> {
  // linear16 WAV so we can measure the take and lay it on the grid.
  // The binding sometimes still returns MP3; decodeWav tells those apart.
  const result: unknown = await env.AI.run("@cf/deepgram/aura-2-en", {
    text,
    speaker,
    encoding: "linear16",
    container: "wav",
    sample_rate: 24000,
  });
  return readAudioBytes(result);
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += alphabet[(n >> 18) & 63];
    out += alphabet[(n >> 12) & 63];
    out += i + 1 < bytes.length ? alphabet[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? alphabet[n & 63] : "=";
  }
  return out;
}

const POCKET_RATE = 24000;

/**
 * Synthesize a verse as one object in R2.
 * PCM takes are packed onto the beat and stored as WAV (playback rate 1).
 * If Aura returns MP3 instead, store a phrase manifest the deck schedules.
 */
export async function synthesizeVerse(
  env: Env,
  text: string,
  voiceId: string = CALM_SPEAKER,
  bpm: number = 90
): Promise<string> {
  const lines = verseLines(text);
  if (!lines.length) throw new Error("Nothing to speak");
  const speaker = resolveSpeaker(voiceId);
  const tempo = sanitizeBpm(bpm);

  const raw: Array<Uint8Array | null> = [];
  const pcm: Array<Float32Array | null> = [];
  let allPcm = true;

  for (const line of lines) {
    if (!line.trim()) {
      raw.push(null);
      pcm.push(null);
      continue;
    }
    const bytes = await synthLine(env, spokenLine(line), speaker);
    raw.push(bytes);
    const decoded = decodeWav(bytes);
    if (!decoded) {
      allPcm = false;
      pcm.push(null);
      continue;
    }
    const atRate = resample(decoded.samples, decoded.sampleRate, POCKET_RATE);
    pcm.push(preparePhrase(atRate, POCKET_RATE));
  }

  if (allPcm) {
    const packed = packPocket(pcm, POCKET_RATE, tempo);
    const wav = encodeWav(packed.pcm, POCKET_RATE);
    const key = `verses/${crypto.randomUUID()}.wav`;
    await env.AUDIO.put(key, wav, {
      httpMetadata: { contentType: "audio/wav" },
      customMetadata: {
        pocket: "1",
        calmRate: String(CALM_RATE),
        bpm: String(tempo),
        phraseStarts: packed.phraseStarts.map((t) => t.toFixed(4)).join(","),
      },
    });
    return key;
  }

  const key = `verses/${crypto.randomUUID()}.pocket.json`;
  const body = JSON.stringify({
    v: 1,
    calmRate: CALM_RATE,
    bpm: tempo,
    phrases: raw.map((chunk) => (chunk ? bytesToBase64(chunk) : null)),
  });
  await env.AUDIO.put(key, body, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      pocket: "1",
      calmRate: String(CALM_RATE),
      bpm: String(tempo),
    },
  });
  return key;
}
