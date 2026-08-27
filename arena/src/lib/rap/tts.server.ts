import { VOICE_BY_ID } from "./voices";

/**
 * Turn a written stanza into spoken cadence.
 * Line breaks become breaths. Stanza breaks get a longer rest.
 * Punchlines and questions get emphasis. The closer builds.
 */
export function tagRapVerse(text: string): string {
  const stanzas = text
    .replace(/\r/g, "")
    .trim()
    .split(/\n\s*\n/);

  const tagged = stanzas.map((stanza, si) => {
    const lines = stanza
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const lastStanza = si === stanzas.length - 1;
    return lines
      .map((line, i) => {
        const lastLine = i === lines.length - 1;
        const closer = lastStanza && lastLine;
        if (/\?\s*$/.test(line)) return `<emphasis>${line}</emphasis>`;
        if (closer) return `<build-intensity><emphasis>${line}</emphasis></build-intensity>`;
        if (lastLine) return `${line} [pause]`;
        return `${line} [breath]`;
      })
      .join(" ");
  });

  return tagged.join(" [long-pause] ");
}

export function resolveXaiVoice(voiceId: string) {
  return VOICE_BY_ID[voiceId] ?? VOICE_BY_ID.zeus;
}

export async function synthesizeRap(text: string, voiceId: string): Promise<{
  mime: string;
  audioB64: string;
}> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("NO_KEY");

  const voice = resolveXaiVoice(voiceId);
  const tagged = tagRapVerse(text);
  const speed = voice.style === "dramatic" || voice.style === "authoritative" ? 0.92 : 0.96;

  const res = await fetch("https://api.x.ai/v1/tts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      text: tagged.slice(0, 15000),
      voice_id: voice.xai,
      language: "en",
      speed,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`TTS ${res.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return { mime: "audio/mpeg", audioB64: buf.toString("base64") };
}
