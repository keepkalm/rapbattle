/**
 * Text-to-speech via Cloudflare Workers AI (Deepgram Aura)
 * Stores the resulting audio in R2 and returns the object key.
 */

export async function synthesizeVerse(
  env: Env,
  text: string,
  voiceId: string = "luna"
): Promise<string> {
  const result = await env.AI.run("@cf/deepgram/aura-2-en", {
    text,
    speaker: voiceId,
    encoding: "mp3",
  });

  // Workers AI TTS returns audio data (ArrayBuffer or readable stream depending on version)
  const audioBuffer = result instanceof ArrayBuffer
    ? result
    : await new Response(result as any).arrayBuffer();

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
