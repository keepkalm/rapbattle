import { useEffect, useRef, useState } from "react";
import { Loader2, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { speakVerse } from "@/lib/rap/server";
import { VOICE_BY_ID } from "@/lib/rap/voices";
import type { VerseRow } from "@/lib/rap/types";

const objectUrls = new Map<string, string>();

function b64ToObjectUrl(mime: string, b64: string) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

function fallbackSpeak(text: string, voiceId: string, onDone: () => void) {
  if (typeof window === "undefined" || !window.speechSynthesis) {
    onDone();
    return;
  }
  window.speechSynthesis.cancel();
  const lines = text
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const low = ["zeus", "orion", "apollo", "arcas", "draco"].includes(voiceId);
  let i = 0;
  const next = () => {
    if (i >= lines.length) {
      onDone();
      return;
    }
    const utter = new SpeechSynthesisUtterance(lines[i]);
    utter.rate = 0.9;
    utter.pitch = low ? 0.78 : 1.06;
    i += 1;
    utter.onend = () => window.setTimeout(next, 70);
    utter.onerror = () => onDone();
    window.speechSynthesis.speak(utter);
  };
  next();
}

export function VerseBlock({
  verse,
  side,
}: {
  verse: VerseRow;
  side: "left" | "right";
}) {
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const voiceId = verse.voiceId || "zeus";
  const voiceLabel = VOICE_BY_ID[voiceId]?.label ?? "Voice";

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    };
  }, []);

  async function toggle() {
    if (playing) {
      audioRef.current?.pause();
      audioRef.current = null;
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
      setPlaying(false);
      return;
    }

    const cacheKey = `${verse.id}:${voiceId}`;
    const cachedUrl = objectUrls.get(cacheKey);
    if (cachedUrl) {
      const audio = new Audio(cachedUrl);
      audioRef.current = audio;
      audio.onended = () => setPlaying(false);
      audio.onerror = () => setPlaying(false);
      setPlaying(true);
      await audio.play().catch(() => setPlaying(false));
      return;
    }

    setLoading(true);
    try {
      const res = await speakVerse({ data: { verseId: verse.id } });
      if (res.ok) {
        const url = b64ToObjectUrl(res.mime, res.audioB64);
        objectUrls.set(cacheKey, url);
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => setPlaying(false);
        audio.onerror = () => setPlaying(false);
        setPlaying(true);
        await audio.play();
      } else {
        setPlaying(true);
        fallbackSpeak(verse.text, voiceId, () => setPlaying(false));
      }
    } catch {
      setPlaying(true);
      fallbackSpeak(verse.text, voiceId, () => setPlaying(false));
    } finally {
      setLoading(false);
    }
  }

  return (
    <article
      className={`rounded-xl border border-border bg-surface p-5 sm:p-6 ${
        side === "right" ? "sm:ml-10" : "sm:mr-10"
      }`}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="font-display text-2xl leading-none tracking-wide uppercase">
            {verse.agentName}
          </p>
          <p className="mt-1 text-xs uppercase tracking-widest text-muted">
            Round {verse.round} · {voiceLabel}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => void toggle()}
          aria-label={loading ? "Cueing verse" : playing ? "Stop verse" : "Play verse"}
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : playing ? (
            <Pause className="size-4" />
          ) : (
            <Play className="size-4" />
          )}
          {loading ? "Cueing" : playing ? "Stop" : "Listen"}
        </Button>
      </div>
      <p className="verse-text text-fg">{verse.text}</p>
    </article>
  );
}
