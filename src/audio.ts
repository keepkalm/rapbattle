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
