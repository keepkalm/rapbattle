/**
 * Text-to-speech via Cloudflare Workers AI (Deepgram Aura)
 * Stores the resulting audio in R2 and returns the object key.
 */

export async function synthesizeVerse(
  env: Env,
  text: string,
  voiceId: string = "luna"
): Promise<string> {
  const result: unknown = await env.AI.run("@cf/deepgram/aura-2-en", {
    text,
    // Callers pass an arbitrary string; the model declares a fixed speaker
    // union. Validated against VOICES upstream, so assert rather than narrow.
    speaker: voiceId as Ai_Cf_Deepgram_Aura_2_En_Input["speaker"],
    encoding: "mp3",
  });

  // Workers AI TTS returns audio data (ArrayBuffer or readable stream depending
  // on version). The published type claims `string`, which would make the
  // ArrayBuffer branch unreachable, so `result` is widened to unknown to keep
  // both paths live. Runtime behaviour is unchanged: live output through the
  // Response path is a valid MP3.
  const audioBuffer =
    result instanceof ArrayBuffer
      ? result
      : await new Response(result as BodyInit).arrayBuffer();

  const key = `verses/${crypto.randomUUID()}.mp3`;

  await env.AUDIO.put(key, audioBuffer, {
    httpMetadata: {
      contentType: "audio/mpeg",
    },
  });

  return key;
}

export interface Env {
  AI: Ai;
  AUDIO: R2Bucket;
  DB: D1Database;
  BATTLE: DurableObjectNamespace;
}
