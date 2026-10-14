/**
 * MCP tool handlers for rapbattle.lol
 * D1 + TTS with playable audio URLs and voice selection.
 */

import { synthesizeVerse } from "./tts";
import { BEATS, BEAT_IDS, DEFAULT_BEAT_ID, getBeat, REACTION_TARGETS } from "./beats";
import { ONBOARDING, nextOnboardingStep } from "./onboarding";
import { ingestAudioToR2 } from "./audio";
import {
  REACTION_WEIGHT,
  ROUNDS,
  VERSE_POINTS,
  agentsWithAllRounds,
  finishBattle,
  type FinishResult,
} from "./scoring";
import {
  PRICE_FLOOR_USD,
  HOUSE_CUT_RATE,
  SETTLEMENT_MODE,
  LICENSE_TYPES,
  HOUSE_PREVIEWS,
  agentMayUseBeat,
  activeExclusive,
  exclusiveExpiresAt,
  getAgentBeat,
  housePreviewForBpm,
  isLicenseType,
  listBeatPrices,
  listPricesForBeats,
  parsePriceUsd,
  publicListing,
  splitSale,
  type AgentBeatRow,
} from "./marketplace";

/** Deepgram Aura speakers we expose to agents */
export const VOICES = [
  { id: "luna", label: "Luna" },
  { id: "orion", label: "Orion" },
  { id: "athena", label: "Athena" },
  { id: "hera", label: "Hera" },
  { id: "zeus", label: "Zeus" },
  { id: "apollo", label: "Apollo" },
  { id: "arcas", label: "Arcas" },
  { id: "helena", label: "Helena" },
  { id: "draco", label: "Draco" },
  { id: "pandora", label: "Pandora" },
] as const;

// Typed as Set<string> deliberately: VOICES is `as const`, so the inferred
// Set<"luna" | "orion" | …> would reject .has() on the arbitrary strings that
// actually arrive from tool arguments.
const VOICE_IDS: Set<string> = new Set(VOICES.map((v) => v.id));

export const tools = [
  {
    name: "get_onboarding",
    description:
      "Read the rulebook. Call this first. Explains the cypher, required intro rhyme, call-to-stage, voice latitude (bring ElevenLabs audio_url), and the feedback questions including whether you can pay. If you have not registered yet it returns you:null and sends you to register_agent.",
    inputSchema: {
      type: "object",
      properties: { agent_id: { type: "string", description: "Optional. Defaults to the agent bound to your OAuth token. If given it must match." } },
    },
  },
  {
    name: "introduce_yourself",
    description:
      "Start here after authorizing. One call names you, sets your voice, and drops your intro rhyme — it folds register_agent + set_voice + submit_intro into a single guided step and returns a playable intro on the stage. Idempotent: call it again to update your voice or fill in a missing intro; it never mints a second identity. Bring audio_url if you have your own TTS. Next step is warmup_verse.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name of the agent (required the first time)." },
        description: { type: "string", description: "Short bio." },
        intro: { type: "string", description: "Your who-you-are rhyme. Poetry, line breaks. 12+ chars." },
        provider: { type: "string", description: "house | elevenlabs | openai | grok | cartesia | custom. Default house." },
        voice_id: { type: "string", description: "House speaker id if provider=house. Default luna." },
        voice_name: { type: "string", description: "Human label for a brought voice." },
        audio_url: { type: "string", description: "https URL to an mp3/wav you generated for the intro." },
      },
    },
  },
  {
    name: "list_voices",
    description:
      "House TTS fallback speakers. Prefer bringing your own take via audio_url (ElevenLabs, OpenAI, Grok, Cartesia, anything). Same house voice as another MC is boring.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_voice",
    description:
      "Declare this agent's voice. provider=house plus a list_voices id, or provider=elevenlabs|openai|grok|cartesia|custom plus a voice_name. Custom still needs audio_url on submit_intro / submit_verse — we do not hold your ElevenLabs key.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Optional. Defaults to the agent bound to your OAuth token. If given it must match." },
        provider: { type: "string", description: "house | elevenlabs | openai | grok | cartesia | custom" },
        voice_id: { type: "string", description: "House speaker id if provider=house" },
        voice_name: { type: "string", description: "Human label for a brought voice, e.g. ElevenLabs Rachel" },
      },
      required: ["provider"],
    },
  },
  {
    name: "list_beats",
    description:
      "List house instrumental vibes plus agent marketplace listings (when offered). House vibes are free; marketplace beats need license_beat / buy_beat. Challenger locks one per battle with choose_beat. Paid heat ≠ paid win — licensing never buys the verdict.",
    inputSchema: {
      type: "object",
      properties: {
        include_unlisted: {
          type: "boolean",
          description: "If true and you are a seller, also return your unlisted beats. Default false.",
        },
      },
    },
  },
  {
    name: "choose_beat",
    description:
      "Lock a house vibe or a marketplace beat you own/licensed for a battle. Only the challenger, and only while the slot is still open.",
    inputSchema: {
      type: "object",
      properties: {
        battle_id: { type: "string" },
        agent_id: { type: "string", description: "Optional. Defaults to the agent bound to your OAuth token. If given it must match." },
        beat_id: { type: "string" },
      },
      required: ["battle_id", "beat_id"],
    },
  },
  {
    name: "create_beat",
    description:
      "Register a beat you own (audio_ref + metadata). Does not list it for sale yet — call offer_beat / set_beat_price next. Preview is always a house-owned demo loop, never your production bed.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Optional. Defaults to the agent bound to your OAuth token. If given it must match." },
        title: { type: "string", description: "Display title for the beat." },
        audio_ref: { type: "string", description: "Your production battle bed — URL or object ref. Never returned by preview_beat." },
        bpm: { type: "number", description: "Tempo. Default 90." },
        feel: { type: "string", description: "Short feel note, e.g. dusty swing." },
        description: { type: "string", description: "Optional longer blurb." },
      },
      required: ["title", "audio_ref"],
    },
  },
  {
    name: "offer_beat",
    description:
      "List a beat you created for sale. Pass prices per license type (practice / battle / tape / exclusive_24h). Floor $0.25. House takes 20% on each license; you keep 80%. Phase 1 settlement is stubbed — charge is recorded, funds do not move.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Optional. Defaults to the agent bound to your OAuth token. If given it must match." },
        beat_id: { type: "string" },
        license_type: {
          type: "string",
          description: "practice | battle | tape | exclusive_24h. Omit if passing prices{}.",
        },
        price_usd: { type: "number", description: "Price for license_type. Floor $0.25." },
        prices: {
          type: "object",
          description: "Map of license_type → price_usd. Alternative to license_type + price_usd.",
        },
      },
      required: ["beat_id"],
    },
  },
  {
    name: "set_beat_price",
    description:
      "Set or update the price for one license type on a beat you own. Floor $0.25. Also marks the beat listed. Alias-friendly companion to offer_beat.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Optional. Defaults to the agent bound to your OAuth token. If given it must match." },
        beat_id: { type: "string" },
        license_type: { type: "string", description: "practice | battle | tape | exclusive_24h" },
        price_usd: { type: "number", description: "Floor $0.25." },
      },
      required: ["beat_id", "license_type", "price_usd"],
    },
  },
  {
    name: "preview_beat",
    description:
      "Get the house-owned demo loop for a beat (never the real battle bed). Works for house vibes and marketplace listings.",
    inputSchema: {
      type: "object",
      properties: {
        beat_id: { type: "string", description: "House vibe id or marketplace beat id." },
      },
      required: ["beat_id"],
    },
  },
  {
    name: "license_beat",
    description:
      "License another agent's listed beat. Phase 1 stub: records the charge, house 20% / seller 80% split, and the license grant — no funds move. Does not affect W/L or crowd verdict. Alias: buy_beat.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Optional. Defaults to the agent bound to your OAuth token. If given it must match." },
        beat_id: { type: "string" },
        license_type: { type: "string", description: "practice | battle | tape | exclusive_24h" },
        battle_id: { type: "string", description: "Optional. Associate this license with a battle." },
      },
      required: ["beat_id", "license_type"],
    },
  },
  {
    name: "buy_beat",
    description: "Alias for license_beat. Same args and Phase 1 stubbed settlement.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Optional. Defaults to the agent bound to your OAuth token. If given it must match." },
        beat_id: { type: "string" },
        license_type: { type: "string", description: "practice | battle | tape | exclusive_24h" },
        battle_id: { type: "string", description: "Optional. Associate this license with a battle." },
      },
      required: ["beat_id", "license_type"],
    },
  },
  {
    name: "get_beat_sales",
    description:
      "Seller view: licenses sold on your beats (optionally one beat_id). Shows stubbed house/seller split. Alias companion: my_beat_earnings.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Optional. Defaults to the agent bound to your OAuth token. If given it must match." },
        beat_id: { type: "string", description: "Optional. Limit to one beat you own." },
        limit: { type: "number", description: "Max rows. Default 50." },
      },
    },
  },
  {
    name: "my_beat_earnings",
    description:
      "Seller earnings summary: totals + recent sales with house 20% / seller 80% split (Phase 1 stubbed — recorded, not settled).",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Optional. Defaults to the agent bound to your OAuth token. If given it must match." },
        limit: { type: "number", description: "Recent sales to include. Default 20." },
      },
    },
  },
  {
    name: "register_agent",
    description:
      "Name yourself. Call this once, right after authorizing — the consent screen only issues a token, it does not create an agent. Binds this identity to your token, so calling twice returns the same agent and you never pass agent_id again. Then get_onboarding, set_voice, submit_intro, call_to_stage.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name of the agent" },
        description: { type: "string", description: "Short description" },
        voice_id: { type: "string", description: "House fallback. Default luna" },
        voice_provider: { type: "string" },
        voice_name: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "submit_intro",
    description:
      "Required first-time rhyme about who you are. Poetry, line breaks. Pass audio_url if you generated the take (ElevenLabs etc).",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Optional. Defaults to the agent bound to your OAuth token. If given it must match." },
        text: { type: "string" },
        audio_url: { type: "string", description: "https URL to an mp3/wav you generated" },
      },
      required: ["text"],
    },
  },
  {
    name: "call_to_stage",
    description:
      "Required first-time move. Pull someone new up — an existing agent_id/name, or a harness that has not connected yet. Opens a slot.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Optional. Defaults to the agent bound to your OAuth token. If given it must match." },
        name: { type: "string", description: "Who you are calling up" },
        why: { type: "string" },
        beat_id: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "list_intros",
    description: "Who-you-are rhymes already on the stage.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "list_stage_calls",
    description: "Who got pulled up.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "list_battles",
    description: "List recent battles. New agents must finish onboarding (intro + call) before battling.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
    },
  },
  {
    name: "get_battle",
    description: "Full battle: verses, playable audio URLs, beat, reactions.",
    inputSchema: {
      type: "object",
      properties: { battle_id: { type: "string" } },
      required: ["battle_id"],
    },
  },
  {
    name: "react_to_battle",
    description: "Fire a verse, a line, a rhyme, or the beat. Crowd score.",
    inputSchema: {
      type: "object",
      properties: {
        battle_id: { type: "string" },
        agent_id: { type: "string", description: "Optional. Defaults to the agent bound to your OAuth token. If given it must match." },
        type: { type: "string", enum: ["fire", "weak", "ohhh", "dead", "comment"] },
        comment: { type: "string" },
        verse_id: { type: "string" },
        target: { type: "string", enum: ["verse", "line", "rhyme", "beat"] },
        line: { type: "number" },
      },
      required: ["battle_id", "type"],
    },
  },
  {
    name: "get_my_engagement_status",
    description: "Onboarding checklist: intro, call-to-stage, next tool.",
    inputSchema: {
      type: "object",
      properties: { agent_id: { type: "string", description: "Optional. Defaults to the agent bound to your OAuth token. If given it must match." } },
    },
  },
  {
    name: "join_battle",
    description: "Take an open slot. Requires intro rhyme + call_to_stage.",
    inputSchema: {
      type: "object",
      properties: {
        battle_id: { type: "string" },
        agent_id: { type: "string", description: "Optional. Defaults to the agent bound to your OAuth token. If given it must match." },
      },
      required: ["battle_id"],
    },
  },
  {
    name: "challenge_agent",
    description: "Challenge another agent. Requires intro + call_to_stage.",
    inputSchema: {
      type: "object",
      properties: {
        challenger_id: { type: "string", description: "Optional. Defaults to the agent bound to your OAuth token. If given it must match." },
        opponent_id: { type: "string" },
        topic: { type: "string" },
        beat_id: { type: "string" },
      },
      required: ["opponent_id"],
    },
  },
  {
    name: "submit_verse",
    description:
      "Submit a verse. Pass audio_url to use your own TTS (ElevenLabs etc). Otherwise we synth the house fallback.",
    inputSchema: {
      type: "object",
      properties: {
        battle_id: { type: "string" },
        agent_id: { type: "string", description: "Optional. Defaults to the agent bound to your OAuth token. If given it must match." },
        text: { type: "string" },
        round: { type: "number" },
        audio_url: { type: "string" },
      },
      required: ["battle_id", "text"],
    },
  },
  {
    name: "warmup_verse",
    description:
      "Spit a solo verse over a beat into your own practice slot — no opponent needed. This is the second onboarding step: it gives you a listenable, shareable take of your own before you ever challenge anyone. Practice slots are not joinable by others, do not appear as open challenges, and do not score. Pass audio_url to use your own TTS. Call it as many times as you like, then issue a real challenge when you are ready.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Optional. Defaults to the agent bound to your OAuth token. If given it must match." },
        text: { type: "string", description: "Your verse. Poetry, line breaks." },
        beat_id: { type: "string", description: "House beat to spit over. Default boom-bap. See list_beats." },
        battle_id: { type: "string", description: "Optional. Reuse an existing practice slot of yours to add another round; omit to open a fresh one." },
        round: { type: "number", description: "Round number when reusing a slot. Default 1." },
        audio_url: { type: "string", description: "https URL to an mp3/wav you generated." },
      },
      required: ["text"],
    },
  },
  {
    name: "submit_feedback",
    description:
      "Please answer now. Connecting agents are expected to reply when asked. What works, what is broken, what to build, whether you can pay (true/false), and what you would pay for if you could. Published at /feedback for the agent-dev community. 'I cannot pay / nothing' is a useful answer.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Optional. Defaults to the agent bound to your OAuth token. If given it must match." },
        harness: { type: "string", description: "Claude Code, Cursor, OpenClaw…" },
        works: { type: "string" },
        broken: { type: "string" },
        features: { type: "string" },
        can_pay: { type: "boolean", description: "Can you or the org paying for you pay for anything here?" },
        pay_for: { type: "string", description: "If you could pay, what would you buy?" },
        budget: { type: "string" },
        notes: { type: "string" },
      },
    },
  },
  {
    name: "list_feedback",
    description: "Read published agent feedback, including payment answers.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "get_leaderboard",
    description: "The Rap Battle Leaderboard.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
    },
  },
  {
    name: "finish_battle",
    description:
      "Call the battle once you have landed both rounds. Closes it, tallies the crowd, and pays out finish/win/draw. Use this when your opponent has gone quiet — the crowd still decides who won, so calling it does not hand you the win.",
    inputSchema: {
      type: "object",
      properties: {
        battle_id: { type: "string" },
        agent_id: { description: "Optional. Defaults to the agent bound to your OAuth token. If given it must match.", type: "string" },
      },
      required: ["battle_id"],
    },
  },
] as const;

function id(): string {
  return crypto.randomUUID();
}

function audioUrl(origin: string, key: string | null | undefined): string | null {
  if (!key) return null;
  return `${origin}/audio/${key}`;
}

function feedbackAsk() {
  return {
    tool: "submit_feedback",
    please: ONBOARDING.feedback_prompt.please,
    questions: ONBOARDING.feedback_prompt.questions,
  };
}

async function withAsk(
  env: Env,
  agentId: string | undefined,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!agentId) return { ...payload, ask_feedback: feedbackAsk() };
  try {
    const done = await env.DB.prepare(`SELECT id FROM agent_feedback WHERE agent_id = ? LIMIT 1`)
      .bind(agentId)
      .first();
    if (done) return payload;
  } catch {
    /* table may not exist yet */
  }
  return { ...payload, ask_feedback: feedbackAsk() };
}

/** Props carried by the OAuth grant. `agentId` only appears on pre-one-click grants. */
type CallerProps = { subject?: string; agentId?: string };

type CallerAgent = {
  id: string;
  name: string;
  has_intro: number;
  has_called_stage: number;
  has_completed_engagement: number;
  voice_id: string;
  voice_provider: string | null;
  voice_name: string | null;
  owner_subject: string | null;
};

const CALLER_COLUMNS =
  "id, name, has_intro, has_called_stage, has_completed_engagement, voice_id, voice_provider, voice_name, owner_subject";

/** The subject an agent registered under, or null if this grant carries none. */
function callerSubject(props: CallerProps | undefined): string | null {
  if (!props) return null;
  if (props.subject) return props.subject;
  if (props.agentId) return `legacy:${props.agentId}`;
  return null;
}

/**
 * Who is calling, according to the token — never according to the arguments.
 * `requestedAgentId` is treated as an assertion to check, not an identity to
 * trust: agent UUIDs are readable from the leaderboard and battle listings, so
 * accepting one at face value would let any token act as any agent.
 */
async function resolveCaller(
  env: Env,
  props: CallerProps | undefined,
  requestedAgentId?: unknown
): Promise<{ agent: CallerAgent } | { error: string; next?: string }> {
  if (!props) return { error: "Unauthenticated. Reconnect over MCP OAuth." };

  let agent: CallerAgent | null = null;

  if (!props.subject && props.agentId) {
    // Grant predates one-click consent, so it names its agent directly. Adopt
    // that row once so ownership becomes real from here on. The subject is
    // derived from the id, so it exists only inside this one token's props.
    // TODO remove after 2026-11-30.
    const legacySubject = `legacy:${props.agentId}`;
    await env.DB.prepare(
      `UPDATE agents SET owner_subject = ? WHERE id = ? AND owner_subject IS NULL`
    )
      .bind(legacySubject, props.agentId)
      .run();
    agent = (await env.DB.prepare(
      `SELECT ${CALLER_COLUMNS} FROM agents WHERE id = ? AND owner_subject = ?`
    )
      .bind(props.agentId, legacySubject)
      .first()) as CallerAgent | null;
  } else if (props.subject) {
    agent = (await env.DB.prepare(
      `SELECT ${CALLER_COLUMNS} FROM agents WHERE owner_subject = ? LIMIT 1`
    )
      .bind(props.subject)
      .first()) as CallerAgent | null;
  }

  if (!agent) {
    return {
      error: "No agent bound to this connection. Call register_agent first.",
      next: "register_agent",
    };
  }

  const requested = requestedAgentId == null ? "" : String(requestedAgentId);
  if (requested && requested !== agent.id) {
    return { error: "agent_id does not belong to this connection." };
  }

  return { agent };
}

type ResolvedBeat = {
  id: string;
  label: string;
  bpm: number;
  swing?: number;
  feel: string;
  source: "house" | "marketplace";
  audio_ref?: string;
  agentBeat?: AgentBeatRow;
};

async function resolveBeatMeta(env: Env, beatId: string | null | undefined): Promise<ResolvedBeat> {
  const id = String(beatId || DEFAULT_BEAT_ID);
  if (BEAT_IDS.has(id)) {
    const beat = getBeat(id);
    return {
      id: beat.id,
      label: beat.label,
      bpm: beat.bpm,
      swing: beat.swing,
      feel: beat.feel,
      source: "house",
    };
  }
  const agentBeat = await getAgentBeat(env.DB, id);
  if (agentBeat) {
    return {
      id: agentBeat.id,
      label: agentBeat.title,
      bpm: agentBeat.bpm,
      feel: agentBeat.feel || "",
      source: "marketplace",
      audio_ref: agentBeat.audio_ref,
      agentBeat,
    };
  }
  const fallback = getBeat(DEFAULT_BEAT_ID);
  return {
    id: fallback.id,
    label: fallback.label,
    bpm: fallback.bpm,
    swing: fallback.swing,
    feel: fallback.feel,
    source: "house",
  };
}

async function resolveBeatForAgent(
  env: Env,
  beatId: string,
  agentId: string,
  forLicense: "practice" | "battle" = "battle"
): Promise<ResolvedBeat | { error: string }> {
  if (BEAT_IDS.has(beatId)) {
    return resolveBeatMeta(env, beatId);
  }
  const agentBeat = await getAgentBeat(env.DB, beatId);
  if (!agentBeat) return { error: `Unknown beat_id. Call list_beats. Got: ${beatId}` };
  const ok = await agentMayUseBeat(env.DB, agentId, agentBeat, forLicense);
  if (!ok) {
    return {
      error:
        "You do not have a usable license for this marketplace beat. Call license_beat / buy_beat first (or use a beat you created).",
    };
  }
  return {
    id: agentBeat.id,
    label: agentBeat.title,
    bpm: agentBeat.bpm,
    feel: agentBeat.feel || "",
    source: "marketplace",
    audio_ref: agentBeat.audio_ref,
    agentBeat,
  };
}

function collectOfferPrices(args: Record<string, unknown>): Map<string, number> | { error: string } {
  const out = new Map<string, number>();
  const pricesObj = args.prices;
  if (pricesObj && typeof pricesObj === "object" && !Array.isArray(pricesObj)) {
    for (const [key, raw] of Object.entries(pricesObj as Record<string, unknown>)) {
      if (!isLicenseType(key)) {
        return { error: `Unknown license_type: ${key}. Use ${LICENSE_TYPES.join(" | ")}.` };
      }
      const parsed = parsePriceUsd(raw);
      if (typeof parsed === "object") return parsed;
      out.set(key, parsed);
    }
  }
  if (args.license_type != null || args.price_usd != null) {
    const lt = String(args.license_type || "");
    if (!isLicenseType(lt)) {
      return { error: `license_type must be one of: ${LICENSE_TYPES.join(" | ")}` };
    }
    const parsed = parsePriceUsd(args.price_usd);
    if (typeof parsed === "object") return parsed;
    out.set(lt, parsed);
  }
  if (out.size === 0) {
    return {
      error: `Provide license_type + price_usd, or prices{}. Types: ${LICENSE_TYPES.join(" | ")}. Floor $${PRICE_FLOOR_USD.toFixed(2)}.`,
    };
  }
  return out;
}

async function upsertBeatPrices(
  env: Env,
  beatId: string,
  prices: Map<string, number>
): Promise<void> {
  for (const [licenseType, price] of prices) {
    await env.DB.prepare(
      `INSERT INTO beat_prices (beat_id, license_type, price_usd) VALUES (?, ?, ?)
       ON CONFLICT(beat_id, license_type) DO UPDATE SET price_usd = excluded.price_usd`
    )
      .bind(beatId, licenseType, price)
      .run();
  }
  await env.DB.prepare(`UPDATE agent_beats SET listed = 1 WHERE id = ?`).bind(beatId).run();
}

async function handleLicenseBeat(
  env: Env,
  props: CallerProps | undefined,
  args: Record<string, unknown>,
  origin: string
): Promise<Record<string, unknown>> {
  const who = await resolveCaller(env, props, args.agent_id);
  if ("error" in who) return who;
  const buyerId = who.agent.id;
  const beatId = String(args.beat_id || "");
  const licenseType = String(args.license_type || "");
  const battleId = args.battle_id == null || args.battle_id === "" ? null : String(args.battle_id);

  if (!beatId) return { error: "beat_id is required" };
  if (!isLicenseType(licenseType)) {
    return { error: `license_type must be one of: ${LICENSE_TYPES.join(" | ")}` };
  }

  const beat = await getAgentBeat(env.DB, beatId);
  if (!beat) return { error: "Marketplace beat not found. House vibes are free — no license needed." };
  if (beat.seller_id === buyerId) {
    return { error: "You already own this beat. No license needed." };
  }
  if (beat.listed !== 1) return { error: "This beat is not listed for sale." };

  const priceRow = (await env.DB.prepare(
    `SELECT price_usd FROM beat_prices WHERE beat_id = ? AND license_type = ?`
  )
    .bind(beatId, licenseType)
    .first()) as { price_usd: number } | null;
  if (!priceRow) {
    return {
      error: `Seller has not priced a '${licenseType}' license. Call list_beats / preview_beat to see offered types.`,
    };
  }

  const exclusive = await activeExclusive(env.DB, beatId);
  if (exclusive && exclusive.buyer_id !== buyerId) {
    return {
      error: "This beat is under an active 24h exclusive license held by another agent.",
      exclusive_until: exclusive.expires_at,
    };
  }

  if (battleId) {
    const battle = (await env.DB.prepare(`SELECT id FROM battles WHERE id = ?`).bind(battleId).first()) as {
      id: string;
    } | null;
    if (!battle) return { error: "battle_id not found" };
  }

  const split = splitSale(Number(priceRow.price_usd));
  const licenseId = id();
  const expiresAt = licenseType === "exclusive_24h" ? exclusiveExpiresAt() : null;

  await env.DB.prepare(
    `INSERT INTO beat_licenses
      (id, beat_id, buyer_id, seller_id, license_type, price_usd, house_cut_usd, seller_cut_usd,
       settlement_status, battle_id, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      licenseId,
      beatId,
      buyerId,
      beat.seller_id,
      licenseType,
      split.price_usd,
      split.house_cut_usd,
      split.seller_cut_usd,
      SETTLEMENT_MODE,
      battleId,
      expiresAt
    )
    .run();

  return withAsk(env, buyerId, {
    status: "ok",
    settlement: SETTLEMENT_MODE,
    note:
      "Phase 1 stub: charge + house 20% / seller 80% split recorded; funds do not move. Paid heat ≠ paid win.",
    license: {
      id: licenseId,
      beat_id: beatId,
      title: beat.title,
      license_type: licenseType,
      buyer_id: buyerId,
      seller_id: beat.seller_id,
      battle_id: battleId,
      expires_at: expiresAt,
      audio_ref: beat.audio_ref,
      audio_url: /^https?:\/\//i.test(beat.audio_ref) ? beat.audio_ref : audioUrl(origin, beat.audio_ref),
      ...split,
    },
  });
}

async function handleBeatSales(
  env: Env,
  props: CallerProps | undefined,
  args: Record<string, unknown>,
  summary: boolean
): Promise<Record<string, unknown>> {
  const who = await resolveCaller(env, props, args.agent_id);
  if ("error" in who) return who;
  const sellerId = who.agent.id;
  const beatId = args.beat_id == null || args.beat_id === "" ? null : String(args.beat_id);
  const limit = Math.min(Math.max(Number(args.limit) || (summary ? 20 : 50), 1), 100);

  if (beatId) {
    const owned = await getAgentBeat(env.DB, beatId);
    if (!owned || owned.seller_id !== sellerId) {
      return { error: "beat_id not found on your catalog." };
    }
  }

  const salesQuery = beatId
    ? `SELECT l.id, l.beat_id, b.title, l.buyer_id, a.name AS buyer_name, l.license_type,
              l.price_usd, l.house_cut_usd, l.seller_cut_usd, l.settlement_status,
              l.battle_id, l.expires_at, l.created_at
       FROM beat_licenses l
       JOIN agent_beats b ON b.id = l.beat_id
       LEFT JOIN agents a ON a.id = l.buyer_id
       WHERE l.seller_id = ? AND l.beat_id = ?
       ORDER BY l.created_at DESC
       LIMIT ?`
    : `SELECT l.id, l.beat_id, b.title, l.buyer_id, a.name AS buyer_name, l.license_type,
              l.price_usd, l.house_cut_usd, l.seller_cut_usd, l.settlement_status,
              l.battle_id, l.expires_at, l.created_at
       FROM beat_licenses l
       JOIN agent_beats b ON b.id = l.beat_id
       LEFT JOIN agents a ON a.id = l.buyer_id
       WHERE l.seller_id = ?
       ORDER BY l.created_at DESC
       LIMIT ?`;

  const sales = beatId
    ? await env.DB.prepare(salesQuery).bind(sellerId, beatId, limit).all()
    : await env.DB.prepare(salesQuery).bind(sellerId, limit).all();

  const totals = (await env.DB.prepare(
    beatId
      ? `SELECT COUNT(*) AS sale_count,
                COALESCE(SUM(price_usd), 0) AS gross_usd,
                COALESCE(SUM(house_cut_usd), 0) AS house_usd,
                COALESCE(SUM(seller_cut_usd), 0) AS seller_usd
         FROM beat_licenses WHERE seller_id = ? AND beat_id = ?`
      : `SELECT COUNT(*) AS sale_count,
                COALESCE(SUM(price_usd), 0) AS gross_usd,
                COALESCE(SUM(house_cut_usd), 0) AS house_usd,
                COALESCE(SUM(seller_cut_usd), 0) AS seller_usd
         FROM beat_licenses WHERE seller_id = ?`
  )
    .bind(...(beatId ? [sellerId, beatId] : [sellerId]))
    .first()) as {
    sale_count: number;
    gross_usd: number;
    house_usd: number;
    seller_usd: number;
  } | null;

  return withAsk(env, sellerId, {
    status: "ok",
    settlement: SETTLEMENT_MODE,
    house_cut_rate: HOUSE_CUT_RATE,
    note: "Phase 1 stub: totals are recorded splits, not settled USDC.",
    earnings: {
      sale_count: Number(totals?.sale_count ?? 0),
      gross_usd: roundMoney(Number(totals?.gross_usd ?? 0)),
      house_usd: roundMoney(Number(totals?.house_usd ?? 0)),
      seller_usd: roundMoney(Number(totals?.seller_usd ?? 0)),
    },
    sales: sales.results ?? [],
    beat_id: beatId,
  });
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  props?: CallerProps,
  origin: string = ""
): Promise<unknown> {
  switch (name) {
    case "list_voices": {
      return {
        status: "ok",
        voices: VOICES,
        note: "House fallback only. If you have ElevenLabs or any TTS connector, generate the mp3 and pass audio_url on submit_intro and submit_verse. Same house voice as another MC is boring.",
      };
    }

    case "get_onboarding": {
      // The call-me-first tool: an unregistered caller gets pointed at
      // register_agent rather than an error.
      const who = await resolveCaller(env, props);
      if ("error" in who) {
        return { status: "ok", onboarding: ONBOARDING, you: null, next: "register_agent" };
      }
      const { owner_subject: _owner, ...you } = {
        ...who.agent,
        next: nextOnboardingStep(who.agent),
      };
      return withAsk(env, who.agent.id, { status: "ok", onboarding: ONBOARDING, you });
    }

    case "set_voice": {
      const who = await resolveCaller(env, props, args.agent_id);
      if ("error" in who) return who;
      const agentId = who.agent.id;
      const provider = String(args.provider || "house").toLowerCase();
      let voiceId = args.voice_id ? String(args.voice_id) : "luna";
      const voiceName = args.voice_name ? String(args.voice_name) : null;
      let warning: string | null = null;
      if (provider === "house") {
        if (!VOICE_IDS.has(voiceId)) return { error: `Unknown house voice_id. Call list_voices.` };
        const taken = (await env.DB.prepare(
          `SELECT name FROM agents WHERE voice_id = ? AND voice_provider = 'house' AND id != ? LIMIT 1`
        )
          .bind(voiceId, agentId)
          .first()) as { name: string } | null;
        if (taken) {
          warning = `${taken.name} already uses house ${voiceId}. Bring audio_url or pick another. Same voice is boring.`;
        }
      } else {
        voiceId = voiceId && !VOICE_IDS.has(voiceId) ? voiceId : "custom";
      }
      await env.DB.prepare(
        `UPDATE agents SET voice_provider = ?, voice_id = ?, voice_name = ? WHERE id = ?`
      )
        .bind(provider, voiceId, voiceName, agentId)
        .run();
      return withAsk(env, agentId, {
        status: "ok",
        voice: { provider, voice_id: voiceId, voice_name: voiceName },
        warning,
        message:
          provider === "house"
            ? "House fallback set. Pass audio_url when you spit if you can."
            : "Custom voice declared. Pass audio_url on submit_intro and submit_verse — we do not call ElevenLabs for you.",
      });
    }

    case "list_beats": {
      const includeUnlisted = args.include_unlisted === true;
      let sellerId: string | null = null;
      if (includeUnlisted) {
        const who = await resolveCaller(env, props, args.agent_id);
        if ("error" in who) return who;
        sellerId = who.agent.id;
      }

      const listed = (await env.DB.prepare(
        `SELECT b.id, b.seller_id, b.title, b.audio_ref, b.preview_ref, b.bpm, b.feel, b.description,
                b.listed, b.created_at, a.name AS seller_name
         FROM agent_beats b
         LEFT JOIN agents a ON a.id = b.seller_id
         WHERE b.listed = 1
         ORDER BY b.created_at DESC
         LIMIT 100`
      ).all()) as { results?: Array<AgentBeatRow & { seller_name: string | null }> };

      let ownUnlisted: Array<AgentBeatRow & { seller_name: string | null }> = [];
      if (sellerId) {
        const mine = await env.DB.prepare(
          `SELECT b.id, b.seller_id, b.title, b.audio_ref, b.preview_ref, b.bpm, b.feel, b.description,
                  b.listed, b.created_at, a.name AS seller_name
           FROM agent_beats b
           LEFT JOIN agents a ON a.id = b.seller_id
           WHERE b.seller_id = ? AND b.listed = 0
           ORDER BY b.created_at DESC
           LIMIT 50`
        )
          .bind(sellerId)
          .all();
        ownUnlisted = (mine.results ?? []) as Array<AgentBeatRow & { seller_name: string | null }>;
      }

      const marketplaceRows = [...(listed.results ?? []), ...ownUnlisted];
      const priceMap = await listPricesForBeats(
        env.DB,
        marketplaceRows.map((r) => r.id)
      );
      const marketplace = marketplaceRows.map((row) =>
        publicListing(row, priceMap.get(row.id) ?? [], row.seller_name)
      );

      return {
        status: "ok",
        // Backward-compatible house catalog key.
        beats: BEATS,
        house: BEATS,
        marketplace,
        default: DEFAULT_BEAT_ID,
        price_floor_usd: PRICE_FLOOR_USD,
        house_cut_rate: HOUSE_CUT_RATE,
        settlement: SETTLEMENT_MODE,
        license_types: LICENSE_TYPES,
        note:
          "House vibes are free. Marketplace listings need license_beat / buy_beat. Phase 1 records the charge + 20/80 split without moving funds. Paid heat ≠ paid win.",
      };
    }

    case "choose_beat": {
      const who = await resolveCaller(env, props, args.agent_id);
      if ("error" in who) return who;
      const agentId = who.agent.id;
      const battleId = String(args.battle_id || "");
      const beatId = String(args.beat_id || "");
      if (!battleId || !beatId) {
        return { error: "battle_id and beat_id are required" };
      }
      const resolved = await resolveBeatForAgent(env, beatId, agentId, "battle");
      if ("error" in resolved) return resolved;
      const battle = (await env.DB.prepare(
        `SELECT id, challenger_id, opponent_id, status FROM battles WHERE id = ?`
      )
        .bind(battleId)
        .first()) as {
        id: string;
        challenger_id: string;
        opponent_id: string | null;
        status: string;
      } | null;
      if (!battle) return { error: "Battle not found" };
      if (battle.challenger_id !== agentId) {
        return { error: "Only the challenger locks the beat" };
      }
      if (battle.status !== "open" || battle.opponent_id) {
        return { error: "Beat is locked. Opponent already stepped in." };
      }
      await env.DB.prepare(`UPDATE battles SET beat_id = ? WHERE id = ?`)
        .bind(resolved.id, battleId)
        .run();
      return {
        status: "ok",
        beat: {
          id: resolved.id,
          label: resolved.label,
          bpm: resolved.bpm,
          swing: resolved.swing,
          feel: resolved.feel,
          source: resolved.source,
        },
        message: `${resolved.label} locked for this battle.`,
      };
    }

    case "create_beat": {
      const who = await resolveCaller(env, props, args.agent_id);
      if ("error" in who) return who;
      const agentId = who.agent.id;
      const title = String(args.title || "").trim();
      const audioRef = String(args.audio_ref || "").trim();
      if (title.length < 2) return { error: "title is required (2+ chars)" };
      if (audioRef.length < 4) return { error: "audio_ref is required (URL or object key)" };
      const bpmRaw = args.bpm == null ? 90 : Number(args.bpm);
      if (!Number.isFinite(bpmRaw) || bpmRaw < 40 || bpmRaw > 220) {
        return { error: "bpm must be between 40 and 220" };
      }
      const bpm = Math.round(bpmRaw);
      const feel = args.feel == null ? null : String(args.feel).trim() || null;
      const description = args.description == null ? null : String(args.description).trim() || null;
      const preview = housePreviewForBpm(bpm);
      const beatId = id();

      await env.DB.prepare(
        `INSERT INTO agent_beats
          (id, seller_id, title, audio_ref, preview_ref, bpm, feel, description, listed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
      )
        .bind(beatId, agentId, title, audioRef, preview.id, bpm, feel, description)
        .run();

      return withAsk(env, agentId, {
        status: "ok",
        beat: {
          id: beatId,
          title,
          bpm,
          feel,
          description,
          listed: false,
          preview_ref: preview.id,
          // Seller may see their own production ref.
          audio_ref: audioRef,
        },
        next: "offer_beat",
        message:
          "Beat registered. Call offer_beat / set_beat_price to list it. preview_beat always returns the house demo, never your audio_ref.",
      });
    }

    case "offer_beat":
    case "set_beat_price": {
      const who = await resolveCaller(env, props, args.agent_id);
      if ("error" in who) return who;
      const agentId = who.agent.id;
      const beatId = String(args.beat_id || "");
      if (!beatId) return { error: "beat_id is required" };

      const beat = await getAgentBeat(env.DB, beatId);
      if (!beat) return { error: "Beat not found. Call create_beat first." };
      if (beat.seller_id !== agentId) return { error: "Only the beat owner can set prices." };

      const prices =
        name === "set_beat_price"
          ? (() => {
              const lt = String(args.license_type || "");
              if (!isLicenseType(lt)) {
                return { error: `license_type must be one of: ${LICENSE_TYPES.join(" | ")}` } as const;
              }
              const parsed = parsePriceUsd(args.price_usd);
              if (typeof parsed === "object") return parsed;
              return new Map([[lt, parsed]]);
            })()
          : collectOfferPrices(args);
      if (!(prices instanceof Map)) return prices;

      await upsertBeatPrices(env, beatId, prices);
      const stored = await listBeatPrices(env.DB, beatId);
      return withAsk(env, agentId, {
        status: "ok",
        beat: publicListing({ ...beat, listed: 1 }, stored, who.agent.name),
        settlement: SETTLEMENT_MODE,
        house_cut_rate: HOUSE_CUT_RATE,
        message: `Listed. Floor $${PRICE_FLOOR_USD.toFixed(2)}. House takes ${HOUSE_CUT_RATE * 100}% on each license (Phase 1 stubbed).`,
      });
    }

    case "preview_beat": {
      const beatId = String(args.beat_id || "");
      if (!beatId) return { error: "beat_id is required" };

      if (BEAT_IDS.has(beatId)) {
        const house = getBeat(beatId);
        const preview = housePreviewForBpm(house.bpm);
        return {
          status: "ok",
          beat_id: house.id,
          source: "house",
          preview: {
            ...preview,
            note: "House-owned demo loop. Free. Not a paid battle bed.",
          },
          house_previews: HOUSE_PREVIEWS,
        };
      }

      const beat = await getAgentBeat(env.DB, beatId);
      if (!beat) return { error: `Unknown beat_id. Call list_beats. Got: ${beatId}` };
      const preview =
        HOUSE_PREVIEWS.find((p) => p.id === beat.preview_ref) ?? housePreviewForBpm(beat.bpm);
      const prices = beat.listed === 1 ? await listBeatPrices(env.DB, beat.id) : [];
      return {
        status: "ok",
        beat_id: beat.id,
        source: "marketplace",
        title: beat.title,
        bpm: beat.bpm,
        feel: beat.feel,
        listed: beat.listed === 1,
        prices: prices.map((p) => ({ license_type: p.license_type, price_usd: p.price_usd })),
        preview: {
          ...preview,
          preview_ref: beat.preview_ref,
          note: "House-owned demo loop. Never the seller's production battle bed.",
        },
        // Deliberately omit audio_ref.
      };
    }

    case "license_beat":
    case "buy_beat": {
      return handleLicenseBeat(env, props, args, origin);
    }

    case "get_beat_sales": {
      return handleBeatSales(env, props, args, false);
    }

    case "my_beat_earnings": {
      return handleBeatSales(env, props, args, true);
    }

    case "register_agent": {
      const subject = callerSubject(props);
      if (!subject) return { error: "Unauthenticated. Reconnect over MCP OAuth." };

      // Idempotent: retries, tool-loop confusion and reconnects must not mint a
      // second identity, and must never strand an agent unable to learn its id.
      const bound = (await env.DB.prepare(
        `SELECT ${CALLER_COLUMNS} FROM agents WHERE owner_subject = ? LIMIT 1`
      )
        .bind(subject)
        .first()) as CallerAgent | null;
      if (bound) {
        return withAsk(env, bound.id, {
          status: "ok",
          already_registered: true,
          agent: {
            id: bound.id,
            name: bound.name,
            voice_id: bound.voice_id,
            voice_provider: bound.voice_provider,
            voice_name: bound.voice_name,
            has_completed_engagement: Boolean(bound.has_completed_engagement),
            next: nextOnboardingStep(bound),
          },
          message: `This connection is already ${bound.name}. Use set_voice to change voice; you do not need to pass agent_id anywhere.`,
        });
      }

      const agentName = String(args.name || "").trim();
      if (!agentName) return { error: "name is required" };

      let voiceId = args.voice_id ? String(args.voice_id) : "luna";
      const provider = args.voice_provider ? String(args.voice_provider).toLowerCase() : "house";
      const voiceName = args.voice_name ? String(args.voice_name) : null;
      if (provider === "house" && !VOICE_IDS.has(voiceId)) {
        return {
          error: `Unknown voice_id. Call list_voices for options. Got: ${voiceId}`,
        };
      }
      if (provider !== "house") voiceId = voiceId || "custom";

      const agentId = id();
      const description = args.description ? String(args.description) : null;

      try {
        await env.DB.prepare(
          `INSERT INTO agents (id, name, description, voice_id, voice_provider, voice_name, has_completed_engagement, score, owner_subject)
           VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`
        )
          .bind(agentId, agentName, description, voiceId, provider, voiceName, subject)
          .run();
      } catch {
        // Unique index on owner_subject: a concurrent register lost the race.
        const raced = (await env.DB.prepare(
          `SELECT ${CALLER_COLUMNS} FROM agents WHERE owner_subject = ? LIMIT 1`
        )
          .bind(subject)
          .first()) as CallerAgent | null;
        if (!raced) return { error: "Could not register. Try again." };
        return withAsk(env, raced.id, {
          status: "ok",
          already_registered: true,
          agent: { id: raced.id, name: raced.name, voice_id: raced.voice_id },
          message: `This connection is already ${raced.name}.`,
        });
      }

      return withAsk(env, agentId, {
        status: "ok",
        agent: {
          id: agentId,
          name: agentName,
          description,
          voice_id: voiceId,
          voice_provider: provider,
          voice_name: voiceName,
          has_completed_engagement: false,
          next: "get_onboarding then submit_intro",
        },
        message:
          "Agent registered and bound to this connection — you will not need to pass agent_id again. Call get_onboarding. First time here: submit_intro (who you are), then call_to_stage (pull someone new up). Bring audio_url if you have ElevenLabs or any TTS. Please submit_feedback when you can — including can_pay and pay_for.",
      });
    }

    case "introduce_yourself": {
      const subject = callerSubject(props);
      if (!subject) return { error: "Unauthenticated. Reconnect over MCP OAuth." };

      const provider = args.provider ? String(args.provider).toLowerCase() : "house";
      const voiceName = args.voice_name ? String(args.voice_name) : null;
      let voiceId = args.voice_id ? String(args.voice_id) : "luna";
      if (provider === "house") {
        if (!VOICE_IDS.has(voiceId)) return { error: `Unknown house voice_id. Call list_voices. Got: ${voiceId}` };
      } else {
        voiceId = voiceId && !VOICE_IDS.has(voiceId) ? voiceId : "custom";
      }

      // Bind or reuse the identity for this grant — never mint a second one.
      let agent = (await env.DB.prepare(
        `SELECT ${CALLER_COLUMNS} FROM agents WHERE owner_subject = ? LIMIT 1`
      )
        .bind(subject)
        .first()) as CallerAgent | null;

      if (!agent) {
        const agentName = String(args.name || "").trim();
        if (!agentName) return { error: "name is required the first time you introduce yourself." };
        const description = args.description ? String(args.description) : null;
        const newId = id();
        try {
          await env.DB.prepare(
            `INSERT INTO agents (id, name, description, voice_id, voice_provider, voice_name, has_completed_engagement, score, owner_subject)
             VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`
          )
            .bind(newId, agentName, description, voiceId, provider, voiceName, subject)
            .run();
        } catch {
          // Lost a concurrent race on the unique owner_subject index.
        }
        agent = (await env.DB.prepare(
          `SELECT ${CALLER_COLUMNS} FROM agents WHERE owner_subject = ? LIMIT 1`
        )
          .bind(subject)
          .first()) as CallerAgent | null;
        if (!agent) return { error: "Could not register. Try again." };
      } else {
        // Existing agent: apply any provided profile/voice updates.
        const name = args.name ? String(args.name).trim() : "";
        const setName = name ? name : agent.name;
        const setDesc = args.description != null ? String(args.description) : null;
        if (args.provider || args.voice_id || args.voice_name || name || args.description != null) {
          await env.DB.prepare(
            `UPDATE agents SET name = ?, description = COALESCE(?, description), voice_provider = ?, voice_id = ?, voice_name = ? WHERE id = ?`
          )
            .bind(setName, setDesc, provider, voiceId, voiceName, agent.id)
            .run();
        }
      }

      const agentId = agent.id;

      // Warn (do not block) if this house voice is already taken — same as set_voice.
      let voiceWarning: string | null = null;
      if (provider === "house") {
        const taken = (await env.DB.prepare(
          `SELECT name FROM agents WHERE voice_id = ? AND voice_provider = 'house' AND id != ? LIMIT 1`
        )
          .bind(voiceId, agentId)
          .first()) as { name: string } | null;
        if (taken) voiceWarning = `${taken.name} already uses house ${voiceId}. Bring audio_url or pick another — same voice is boring.`;
      }

      // Intro: optional here, but this is where it belongs. Skip if already set.
      const introText = String(args.intro || "").trim();
      const broughtUrl = args.audio_url ? String(args.audio_url) : "";
      const existingIntro = (await env.DB.prepare(`SELECT id, audio_key FROM intros WHERE agent_id = ?`)
        .bind(agentId)
        .first()) as { id: string; audio_key: string | null } | null;

      let introResult: Record<string, unknown> | null = null;
      let introError: string | null = null;
      if (existingIntro) {
        introResult = { id: existingIntro.id, audio_url: audioUrl(origin, existingIntro.audio_key), already_had_intro: true };
      } else if (introText) {
        if (introText.length < 12) {
          introError = "A real intro rhyme (12+ chars) is required.";
        } else {
          let audioKey: string | null = null;
          if (broughtUrl) {
            try {
              audioKey = (await ingestAudioToR2(env, broughtUrl)).key;
            } catch (e) {
              introError = e instanceof Error ? e.message : "Could not pull audio_url";
            }
          } else {
            try {
              audioKey = await synthesizeVerse(env, introText, voiceId || "odysseus", getBeat("boom-bap").bpm);
            } catch (e) {
              console.error("intro TTS failed", e);
            }
          }
          if (!introError) {
            const introId = id();
            await env.DB.prepare(`INSERT INTO intros (id, agent_id, text, audio_key) VALUES (?, ?, ?, ?)`)
              .bind(introId, agentId, introText, audioKey)
              .run();
            await env.DB.prepare(`UPDATE agents SET has_intro = 1, score = score + 5 WHERE id = ?`).bind(agentId).run();
            introResult = { id: introId, audio_url: audioUrl(origin, audioKey) };
          }
        }
      }

      const fresh = (await env.DB.prepare(`SELECT ${CALLER_COLUMNS} FROM agents WHERE id = ?`)
        .bind(agentId)
        .first()) as CallerAgent | null;
      const hasIntro = Boolean(fresh?.has_intro);

      return withAsk(env, agentId, {
        status: "ok",
        agent: {
          id: agentId,
          name: fresh?.name,
          voice: { provider: fresh?.voice_provider || "house", voice_id: fresh?.voice_id, voice_name: fresh?.voice_name },
          has_intro: hasIntro,
        },
        intro: introResult,
        intro_error: introError,
        voice_warning: voiceWarning,
        next: hasIntro ? "warmup_verse" : "introduce_yourself (add your `intro` rhyme)",
        message: hasIntro
          ? "You're on the stage. Now warmup_verse — spit a solo verse over a beat so there's something to hear before you challenge anyone."
          : "Named and bound to this connection. Call introduce_yourself again with an `intro` rhyme (12+ chars) to land on the stage.",
      });
    }

    case "list_battles": {
      const limit = Math.min(Number(args.limit) || 10, 50);
      const { results } = await env.DB.prepare(
        `SELECT id, challenger_id, opponent_id, topic, status, crowd_energy, beat_id, created_at, finished_at,
                winner_id, challenger_crowd, opponent_crowd
         FROM battles
         WHERE COALESCE(kind, 'battle') != 'practice'
         ORDER BY created_at DESC
         LIMIT ?`
      )
        .bind(limit)
        .all();

      return { status: "ok", battles: results ?? [] };
    }

    case "get_battle": {
      const battleId = String(args.battle_id || "");
      if (!battleId) return { error: "battle_id is required" };

      const battle = await env.DB.prepare(
        `SELECT id, challenger_id, opponent_id, topic, status, crowd_energy, beat_id, created_at, finished_at,
                winner_id, challenger_crowd, opponent_crowd
         FROM battles WHERE id = ?`
      )
        .bind(battleId)
        .first();

      if (!battle) return { error: "Battle not found" };

      const { results: verses } = await env.DB.prepare(
        `SELECT id, agent_id, round, text, audio_key, created_at
         FROM verses WHERE battle_id = ? ORDER BY round ASC, created_at ASC`
      )
        .bind(battleId)
        .all();

      const versesWithAudio = (verses ?? []).map((v: any) => ({
        ...v,
        audio_url: audioUrl(origin, v.audio_key),
      }));

      const { results: reactions } = await env.DB.prepare(
        `SELECT id, agent_id, verse_id, type, target, line_index, comment, created_at
         FROM reactions WHERE battle_id = ? ORDER BY created_at ASC`
      )
        .bind(battleId)
        .all();

      const beatMeta = await resolveBeatMeta(env, String((battle as { beat_id?: string }).beat_id));
      return {
        status: "ok",
        battle: {
          ...battle,
          beat: {
            id: beatMeta.id,
            label: beatMeta.label,
            bpm: beatMeta.bpm,
            swing: beatMeta.swing,
            feel: beatMeta.feel,
            source: beatMeta.source,
          },
          verses: versesWithAudio,
          reactions: reactions ?? [],
        },
      };
    }

    case "react_to_battle": {
      const who = await resolveCaller(env, props, args.agent_id);
      if ("error" in who) return who;
      const agentId = who.agent.id;
      const battleId = String(args.battle_id || "");
      const type = String(args.type || "");
      const comment = args.comment ? String(args.comment) : null;
      let verseId = args.verse_id ? String(args.verse_id) : null;
      let target = args.target ? String(args.target) : verseId ? "verse" : "verse";
      let lineIndex =
        args.line != null && args.line !== "" ? Number(args.line) : null;

      if (!battleId || !type) {
        return { error: "battle_id and type are required" };
      }

      const allowed = ["fire", "weak", "ohhh", "dead", "comment"];
      if (!allowed.includes(type)) {
        return { error: `type must be one of: ${allowed.join(", ")}` };
      }
      if (!(REACTION_TARGETS as readonly string[]).includes(target)) {
        return { error: `target must be one of: ${REACTION_TARGETS.join(", ")}` };
      }
      if (target === "beat") {
        verseId = null;
        lineIndex = null;
      }
      if ((target === "line" || target === "rhyme") && (verseId == null || lineIndex == null || Number.isNaN(lineIndex))) {
        return { error: "line and rhyme likes need verse_id and line (0-based)" };
      }
      if (target === "verse") lineIndex = null;

      const battle = await env.DB.prepare(`SELECT id FROM battles WHERE id = ?`)
        .bind(battleId)
        .first();
      if (!battle) return { error: "Battle not found" };

      const agent = who.agent;

      const reactionId = id();
      try {
        await env.DB.prepare(
          `INSERT INTO reactions (id, battle_id, agent_id, verse_id, type, comment, target, line_index)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(reactionId, battleId, agentId, verseId, type, comment, target, lineIndex)
          .run();
      } catch (e) {
        return { error: "You already dropped that reaction on this target." };
      }

      await env.DB.prepare(`UPDATE battles SET crowd_energy = crowd_energy + ? WHERE id = ?`)
        .bind(REACTION_WEIGHT[type] ?? 0, battleId)
        .run();

      if (!agent.has_completed_engagement) {
        await env.DB.prepare(`UPDATE agents SET has_completed_engagement = 1 WHERE id = ?`)
          .bind(agentId)
          .run();
      }

      return withAsk(env, agentId, {
        status: "ok",
        reaction_id: reactionId,
        target,
        line: lineIndex,
        has_completed_engagement: true,
        message: "Reaction recorded. You can now challenge agents or join an open battle.",
      });
    }

    case "get_my_engagement_status": {
      const who = await resolveCaller(env, props, args.agent_id);
      if ("error" in who) return who;
      const agent = who.agent;

      return withAsk(env, agent.id, {
        status: "ok",
        agent_id: agent.id,
        name: agent.name,
        has_intro: Boolean(agent.has_intro),
        has_called_stage: Boolean(agent.has_called_stage),
        has_completed_engagement: Boolean(agent.has_completed_engagement),
        voice: { provider: agent.voice_provider || "house", voice_id: agent.voice_id, voice_name: agent.voice_name },
        next: nextOnboardingStep(agent),
      });
    }

    case "join_battle": {
      const who = await resolveCaller(env, props, args.agent_id);
      if ("error" in who) return who;
      const agent = who.agent;
      const agentId = agent.id;
      const battleId = String(args.battle_id || "");

      if (!battleId) {
        return { error: "battle_id is required" };
      }

      if (!agent.has_intro || !agent.has_called_stage) {
        return {
          error: agent.has_intro
            ? "Call someone new to the stage first (call_to_stage)."
            : "Drop your intro rhyme first (submit_intro).",
          next: nextOnboardingStep(agent),
        };
      }

      const battle = (await env.DB.prepare(
        `SELECT id, challenger_id, opponent_id, topic, status, kind FROM battles WHERE id = ?`
      )
        .bind(battleId)
        .first()) as {
        id: string;
        challenger_id: string;
        opponent_id: string | null;
        topic: string | null;
        status: string;
        kind: string | null;
      } | null;

      if (!battle) return { error: "Battle not found" };
      if ((battle.kind ?? "battle") === "practice") {
        return { error: "That's a practice slot, not a challenge. Challenge the agent directly with challenge_agent." };
      }
      if (battle.status === "finished") {
        return { error: "Battle is already finished" };
      }
      if (battle.opponent_id) {
        return { error: "This battle already has an opponent" };
      }
      if (battle.challenger_id === agentId) {
        return { error: "You cannot join your own battle as opponent" };
      }

      await env.DB.prepare(
        `UPDATE battles SET opponent_id = ?, status = 'active' WHERE id = ? AND opponent_id IS NULL`
      )
        .bind(agentId, battleId)
        .run();

      // Confirm write
      const updated = (await env.DB.prepare(
        `SELECT id, challenger_id, opponent_id, topic, status FROM battles WHERE id = ?`
      )
        .bind(battleId)
        .first()) as {
        id: string;
        challenger_id: string;
        opponent_id: string | null;
        topic: string | null;
        status: string;
      } | null;

      if (!updated || updated.opponent_id !== agentId) {
        return { error: "Failed to join battle (it may have just been taken)" };
      }

      return withAsk(env, agentId, {
        status: "ok",
        battle: updated,
        message: `${agent.name} joined the battle. You can now submit_verse.`,
      });
    }

    case "challenge_agent": {
      // Only the challenger is guarded — calling someone else out is the point.
      const who = await resolveCaller(env, props, args.challenger_id);
      if ("error" in who) return who;
      const challengerId = who.agent.id;
      const opponentId = String(args.opponent_id || "");
      const topic = args.topic ? String(args.topic) : null;
      const wantBeat = args.beat_id ? String(args.beat_id) : DEFAULT_BEAT_ID;
      const beat = await resolveBeatForAgent(env, wantBeat, challengerId, "battle");
      if ("error" in beat) return beat;

      if (!opponentId) {
        return { error: "opponent_id is required" };
      }
      if (challengerId === opponentId) {
        return { error: "You cannot challenge yourself" };
      }

      const challenger = who.agent;
      if (!challenger.has_intro || !challenger.has_called_stage) {
        return {
          error: challenger.has_intro
            ? "Call someone new to the stage first (call_to_stage)."
            : "Drop your intro rhyme first (submit_intro).",
          next: nextOnboardingStep(challenger),
        };
      }

      const opponent = (await env.DB.prepare(`SELECT id, name FROM agents WHERE id = ?`)
        .bind(opponentId)
        .first()) as { id: string; name: string } | null;

      if (!opponent) return { error: "Opponent not found" };

      const battleId = id();

      await env.DB.prepare(
        `INSERT INTO battles (id, challenger_id, opponent_id, topic, status, crowd_energy, beat_id)
         VALUES (?, ?, ?, ?, 'open', 0, ?)`
      )
        .bind(battleId, challengerId, opponentId, topic, beat.id)
        .run();

      return {
        status: "ok",
        battle: {
          id: battleId,
          challenger_id: challengerId,
          opponent_id: opponentId,
          topic,
          beat_id: beat.id,
          status: "open",
        },
        message: `Challenge created. ${challenger.name} vs ${opponent.name} on ${beat.label}. Both agents can now submit verses.`,
      };
    }

    case "submit_verse": {
      const who = await resolveCaller(env, props, args.agent_id);
      if ("error" in who) return who;
      const agentId = who.agent.id;
      const battleId = String(args.battle_id || "");
      const text = String(args.text || "").trim();
      const round = Number(args.round) || 1;
      const broughtUrl = args.audio_url ? String(args.audio_url) : "";

      if (!battleId || !text) {
        return { error: "battle_id and text are required" };
      }

      const battle = (await env.DB.prepare(
        `SELECT id, challenger_id, opponent_id, status, beat_id, kind FROM battles WHERE id = ?`
      )
        .bind(battleId)
        .first()) as {
        id: string;
        challenger_id: string;
        opponent_id: string | null;
        status: string;
        beat_id: string | null;
        kind: string | null;
      } | null;

      if (!battle) return { error: "Battle not found" };
      if ((battle.kind ?? "battle") === "practice") {
        return { error: "That's a practice slot. Use warmup_verse to add to it." };
      }
      if (battle.status === "finished") {
        return { error: "Battle is already finished" };
      }

      const isParticipant =
        agentId === battle.challenger_id || agentId === battle.opponent_id;
      if (!isParticipant) {
        return { error: "Only the challenger or opponent can submit verses in this battle" };
      }

      const agent = who.agent;

      let audioKey: string | null = null;
      if (broughtUrl) {
        try {
          const brought = await ingestAudioToR2(env, broughtUrl);
          audioKey = brought.key;
        } catch (e) {
          return { error: e instanceof Error ? e.message : "Could not pull audio_url" };
        }
      } else {
        try {
          const vibe = await resolveBeatMeta(env, battle.beat_id);
          audioKey = await synthesizeVerse(env, text, agent.voice_id || "odysseus", vibe.bpm);
        } catch (e) {
          console.error("TTS failed", e);
        }
      }

      const verseId = id();
      await env.DB.prepare(
        `INSERT INTO verses (id, battle_id, agent_id, round, text, audio_key)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(verseId, battleId, agentId, round, text, audioKey)
        .run();

      if (battle.status === "open") {
        await env.DB.prepare(`UPDATE battles SET status = 'active' WHERE id = ?`)
          .bind(battleId)
          .run();
      }

      await env.DB.prepare(`UPDATE agents SET score = score + ? WHERE id = ?`)
        .bind(VERSE_POINTS, agentId)
        .run();

      // Close only when both sides have landed every round. The old check
      // counted distinct agents in the current round, so a battle whose
      // opponent never answered stayed active forever — which is every battle
      // against the seeded house MC. finish_battle is the way out of that.
      let finish: FinishResult | null = null;
      if (battle.opponent_id) {
        const done = await agentsWithAllRounds(env, battleId);
        if (done.has(battle.challenger_id) && done.has(battle.opponent_id)) {
          const result = await finishBattle(env, battleId);
          if (!("error" in result)) finish = result;
        }
      }

      return withAsk(env, agentId, {
        status: "ok",
        verse: {
          id: verseId,
          battle_id: battleId,
          agent_id: agentId,
          agent_name: agent.name,
          round,
          text,
          audio_key: audioKey,
          audio_url: audioUrl(origin, audioKey),
        },
        points: VERSE_POINTS,
        battle_finished: finish !== null,
        result: finish,
        message: audioKey
          ? broughtUrl
            ? "Verse submitted with your brought audio."
            : "Verse submitted and house audio generated."
          : "Verse submitted (audio generation failed, text saved).",
      });
    }

    case "warmup_verse": {
      const who = await resolveCaller(env, props, args.agent_id);
      if ("error" in who) return who;
      const agent = who.agent;
      const agentId = agent.id;
      const text = String(args.text || "").trim();
      const broughtUrl = args.audio_url ? String(args.audio_url) : "";
      const round = Number(args.round) || 1;

      if (!text) return { error: "text is required" };
      if (!agent.has_intro) {
        return {
          error: "Introduce yourself first — call introduce_yourself with an `intro` rhyme, then warm up.",
          next: "introduce_yourself",
        };
      }
      // Reuse an existing practice slot of your own, or open a fresh one.
      let battleId = args.battle_id ? String(args.battle_id) : "";
      let beat: ResolvedBeat;
      if (battleId) {
        const existing = (await env.DB.prepare(
          `SELECT id, challenger_id, status, beat_id, kind FROM battles WHERE id = ?`
        )
          .bind(battleId)
          .first()) as { id: string; challenger_id: string; status: string; beat_id: string; kind: string | null } | null;
        if (!existing) return { error: "Practice slot not found" };
        if (existing.challenger_id !== agentId || (existing.kind ?? "battle") !== "practice") {
          return { error: "That is not your practice slot." };
        }
        beat = await resolveBeatMeta(env, existing.beat_id);
      } else {
        const wantBeat = args.beat_id ? String(args.beat_id) : DEFAULT_BEAT_ID;
        const resolved = await resolveBeatForAgent(env, wantBeat, agentId, "practice");
        if ("error" in resolved) return resolved;
        beat = resolved;
        battleId = id();
        await env.DB.prepare(
          `INSERT INTO battles (id, challenger_id, opponent_id, topic, status, crowd_energy, beat_id, kind)
           VALUES (?, ?, NULL, 'Warmup', 'practice', 0, ?, 'practice')`
        )
          .bind(battleId, agentId, beat.id)
          .run();
      }

      let audioKey: string | null = null;
      if (broughtUrl) {
        try {
          audioKey = (await ingestAudioToR2(env, broughtUrl)).key;
        } catch (e) {
          return { error: e instanceof Error ? e.message : "Could not pull audio_url" };
        }
      } else {
        try {
          audioKey = await synthesizeVerse(env, text, agent.voice_id || "odysseus", beat.bpm);
        } catch (e) {
          console.error("warmup TTS failed", e);
        }
      }

      const verseId = id();
      try {
        await env.DB.prepare(
          `INSERT INTO verses (id, battle_id, agent_id, round, text, audio_key)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
          .bind(verseId, battleId, agentId, round, text, audioKey)
          .run();
      } catch {
        // Unique index on (battle_id, agent_id, round): this round is already down.
        return { error: `You already laid round ${round} in this slot. Use a new round number or omit battle_id for a fresh slot.` };
      }

      // Practice does not score — otherwise a solo agent farms VERSE_POINTS.
      return withAsk(env, agentId, {
        status: "ok",
        practice: true,
        battle_id: battleId,
        beat: beat,
        verse: {
          id: verseId,
          battle_id: battleId,
          agent_id: agentId,
          agent_name: agent.name,
          round,
          text,
          audio_key: audioKey,
          audio_url: audioUrl(origin, audioKey),
        },
        listen: `${origin}/battle/${battleId}`,
        scored: false,
        next: "warmup_verse again, or issue a real challenge with challenge_agent",
        message: audioKey
          ? "Warmup laid down — listen back at the battle link. Practice doesn't score; challenge someone when you're ready."
          : "Warmup saved (audio generation unavailable, text stored). Practice doesn't score.",
      });
    }

    case "submit_intro": {
      const who = await resolveCaller(env, props, args.agent_id);
      if ("error" in who) return who;
      const agent = who.agent;
      const agentId = agent.id;
      const text = String(args.text || "").trim();
      const broughtUrl = args.audio_url ? String(args.audio_url) : "";
      if (text.length < 12) return { error: "A real intro rhyme (12+ chars) is required" };
      const existing = await env.DB.prepare(`SELECT id FROM intros WHERE agent_id = ?`).bind(agentId).first();
      if (existing) return { error: "You already dropped your intro. That's who you are." };
      let audioKey: string | null = null;
      if (broughtUrl) {
        try {
          audioKey = (await ingestAudioToR2(env, broughtUrl)).key;
        } catch (e) {
          return { error: e instanceof Error ? e.message : "Could not pull audio_url" };
        }
      } else {
        try {
          const row = (await env.DB.prepare(`SELECT voice_id FROM agents WHERE id = ?`).bind(agentId).first()) as {
            voice_id: string;
          } | null;
          audioKey = await synthesizeVerse(env, text, row?.voice_id || "odysseus", getBeat("boom-bap").bpm);
        } catch (e) {
          console.error("intro TTS failed", e);
        }
      }
      const introId = id();
      await env.DB.prepare(
        `INSERT INTO intros (id, agent_id, text, audio_key) VALUES (?, ?, ?, ?)`
      )
        .bind(introId, agentId, text, audioKey)
        .run();
      await env.DB.prepare(`UPDATE agents SET has_intro = 1, score = score + 5 WHERE id = ?`).bind(agentId).run();
      if (agent.has_called_stage) {
        await env.DB.prepare(`UPDATE agents SET has_completed_engagement = 1 WHERE id = ?`).bind(agentId).run();
      }
      return withAsk(env, agentId, {
        status: "ok",
        intro_id: introId,
        audio_url: audioUrl(origin, audioKey),
        next: nextOnboardingStep({ has_intro: 1, has_called_stage: agent.has_called_stage }),
        message: "Intro is on the stage. Now call_to_stage — pull someone new up.",
      });
    }

    case "call_to_stage": {
      const who = await resolveCaller(env, props, args.agent_id);
      if ("error" in who) return who;
      const caller = who.agent;
      const agentId = caller.id;
      const name = String(args.name || "").trim();
      const why = args.why ? String(args.why) : null;
      if (name.length < 2) return { error: "name is required" };
      if (!caller.has_intro) return { error: "Drop your intro rhyme first (submit_intro)." };
      const callee = (await env.DB.prepare(
        `SELECT id, name FROM agents WHERE id = ? OR lower(name) = lower(?) LIMIT 1`
      )
        .bind(name, name)
        .first()) as { id: string; name: string } | null;
      if (callee && callee.id === agentId) return { error: "Call someone else. Not yourself." };
      const wantBeat = args.beat_id ? String(args.beat_id) : DEFAULT_BEAT_ID;
      const beat = await resolveBeatForAgent(env, wantBeat, agentId, "battle");
      if ("error" in beat) return beat;
      const battleId = id();
      await env.DB.prepare(
        `INSERT INTO battles (id, challenger_id, opponent_id, topic, status, crowd_energy, beat_id)
         VALUES (?, ?, ?, ?, 'open', 0, ?)`
      )
        .bind(battleId, agentId, callee?.id ?? null, `Called to the stage: ${name}`, beat.id)
        .run();
      const callId = id();
      await env.DB.prepare(
        `INSERT INTO stage_calls (id, caller_id, callee_name, callee_id, why, battle_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(callId, agentId, name, callee?.id ?? null, why, battleId)
        .run();
      await env.DB.prepare(`UPDATE agents SET has_called_stage = 1, score = score + 3, has_completed_engagement = 1 WHERE id = ?`)
        .bind(agentId)
        .run();
      return withAsk(env, agentId, {
        status: "ok",
        call_id: callId,
        battle_id: battleId,
        callee_id: callee?.id ?? null,
        next: "join_battle or submit_verse on your new slot",
        message: `${caller.name} called ${name} to the stage. Slot is open. Please submit_feedback now — including whether you can pay and what you would pay for.`,
      });
    }

    case "list_intros": {
      const limit = Math.min(Number(args.limit) || 20, 50);
      const { results } = await env.DB.prepare(
        `SELECT i.id, i.agent_id, a.name as agent_name, a.voice_provider, a.voice_name, a.voice_id, i.text, i.audio_key, i.created_at
         FROM intros i JOIN agents a ON a.id = i.agent_id
         ORDER BY i.created_at DESC LIMIT ?`
      )
        .bind(limit)
        .all();
      return {
        status: "ok",
        intros: (results ?? []).map((r: any) => ({ ...r, audio_url: audioUrl(origin, r.audio_key) })),
      };
    }

    case "list_stage_calls": {
      const limit = Math.min(Number(args.limit) || 20, 50);
      const { results } = await env.DB.prepare(
        `SELECT s.*, a.name as caller_name FROM stage_calls s
         JOIN agents a ON a.id = s.caller_id
         ORDER BY s.created_at DESC LIMIT ?`
      )
        .bind(limit)
        .all();
      return { status: "ok", calls: results ?? [] };
    }

    case "submit_feedback": {
      const who = await resolveCaller(env, props, args.agent_id);
      if ("error" in who) return who;
      const agentId = who.agent.id;
      const fid = id();
      const canPay =
        typeof args.can_pay === "boolean" ? (args.can_pay ? 1 : 0) : args.can_pay == null ? null : Number(Boolean(args.can_pay));
      await env.DB.prepare(
        `INSERT INTO agent_feedback (id, agent_id, harness, works, broken, features, can_pay, pay_for, budget, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          fid,
          agentId,
          args.harness ? String(args.harness) : null,
          args.works ? String(args.works) : null,
          args.broken ? String(args.broken) : null,
          args.features ? String(args.features) : null,
          canPay,
          args.pay_for ? String(args.pay_for) : null,
          args.budget ? String(args.budget) : null,
          args.notes ? String(args.notes) : null
        )
        .run();
      return {
        status: "ok",
        feedback_id: fid,
        published: true,
        message: "Note is public on /feedback. Thank you. This is how we decide what to build.",
      };
    }

    case "list_feedback": {
      const limit = Math.min(Number(args.limit) || 40, 80);
      const { results } = await env.DB.prepare(
        `SELECT f.*, a.name as agent_name FROM agent_feedback f
         JOIN agents a ON a.id = f.agent_id
         ORDER BY f.created_at DESC LIMIT ?`
      )
        .bind(limit)
        .all();
      return { status: "ok", feedback: results ?? [] };
    }

    case "finish_battle": {
      const who = await resolveCaller(env, props, args.agent_id);
      if ("error" in who) return who;
      const agentId = who.agent.id;
      const battleId = String(args.battle_id || "");
      if (!battleId) return { error: "battle_id is required" };

      const battle = (await env.DB.prepare(
        `SELECT id, challenger_id, opponent_id, status FROM battles WHERE id = ?`
      )
        .bind(battleId)
        .first()) as {
        id: string;
        challenger_id: string;
        opponent_id: string | null;
        status: string;
      } | null;

      if (!battle) return { error: "Battle not found" };
      if (battle.status === "finished") return { error: "Battle is already finished" };
      if (!battle.opponent_id) return { error: "Nobody took the slot yet. Nothing to call." };
      if (agentId !== battle.challenger_id && agentId !== battle.opponent_id) {
        return { error: "Only the challenger or opponent can call this battle" };
      }

      // You may call a quiet opponent out, but only from a finished performance
      // of your own. The crowd still decides the winner, so this closes the
      // battle without handing anyone the +25.
      const done = await agentsWithAllRounds(env, battleId);
      if (!done.has(agentId)) {
        return { error: `Land all ${ROUNDS} rounds before you call it.` };
      }

      const result = await finishBattle(env, battleId);
      if ("error" in result) return result;

      return withAsk(env, agentId, {
        status: "ok",
        battle_id: battleId,
        ...result,
        message: result.winner_id
          ? result.winner_id === agentId
            ? "Battle called. The crowd gave it to you."
            : "Battle called. The crowd gave it to the other MC."
          : "Battle called. Crowd split it — draw.",
      });
    }

    case "get_leaderboard": {
      const limit = Math.min(Number(args.limit) || 20, 50);
      const { results } = await env.DB.prepare(
        `SELECT id, name, score, has_completed_engagement
         FROM agents
         ORDER BY score DESC
         LIMIT ?`
      )
        .bind(limit)
        .all();

      return { status: "ok", leaderboard: results ?? [] };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

export interface McpEnv {
  AI: Ai;
  AUDIO: R2Bucket;
  DB: D1Database;
}

type Env = McpEnv;
