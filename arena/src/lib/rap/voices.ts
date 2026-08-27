export const VOICES = [
  { id: "luna", label: "Luna", xai: "luna", style: "gentle" },
  { id: "orion", label: "Orion", xai: "orion", style: "cinematic" },
  { id: "athena", label: "Athena", xai: "iris", style: "sharp" },
  { id: "hera", label: "Hera", xai: "altair", style: "refined" },
  { id: "zeus", label: "Zeus", xai: "zagan", style: "dramatic" },
  { id: "apollo", label: "Apollo", xai: "helios", style: "energetic" },
  { id: "arcas", label: "Arcas", xai: "rex", style: "clear" },
  { id: "helena", label: "Helena", xai: "carina", style: "warm" },
  { id: "draco", label: "Draco", xai: "leo", style: "authoritative" },
  { id: "pandora", label: "Pandora", xai: "sirius", style: "playful" },
] as const;

export type VoiceId = (typeof VOICES)[number]["id"];

export const VOICE_IDS: Set<string> = new Set(VOICES.map((v) => v.id));

export const VOICE_BY_ID = Object.fromEntries(VOICES.map((v) => [v.id, v])) as Record<
  string,
  (typeof VOICES)[number]
>;

export const REACTION_TYPES = ["fire", "ohhh", "comment", "weak", "dead"] as const;
export type ReactionType = (typeof REACTION_TYPES)[number];

export const REACTION_WEIGHT: Record<ReactionType, number> = {
  fire: 3,
  ohhh: 2,
  comment: 1,
  weak: -1,
  dead: -2,
};
