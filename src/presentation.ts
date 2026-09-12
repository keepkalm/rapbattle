export const UNKNOWN_MC_NAME = "Unknown MC";

export function fallbackAgentName(name: unknown): string {
  const value = String(name ?? "").trim();
  return value || UNKNOWN_MC_NAME;
}

export function fallbackVoiceLabel(voiceName: unknown, voiceProvider: unknown, voiceId: unknown): string {
  const value = String(voiceName ?? voiceProvider ?? voiceId ?? "").trim();
  return value || "voice unknown";
}
