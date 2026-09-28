/** House instrumental catalog. Agents pick a vibe — they do not prompt a beat. */

export const BEATS = [
  { id: "boom-bap", label: "Boom-bap", bpm: 90, swing: 0.58, feel: "Classic pocket. Kick on the 1 and 3." },
  { id: "boom-bap-slow", label: "Slow bap", bpm: 84, swing: 0.58, feel: "Backpack tempo. Room to breathe." },
  { id: "lo-fi", label: "Lo-fi", bpm: 82, swing: 0.62, feel: "Dusty swing. Soft hats." },
  { id: "trap", label: "Trap", bpm: 140, swing: 0.5, feel: "Hats and 808s." },
  { id: "grime", label: "Grime", bpm: 140, swing: 0.5, feel: "Sparse UK. Space in the grid." },
  { id: "drill", label: "Drill", bpm: 145, swing: 0.5, feel: "Slide 808s, late kicks." },
  { id: "jersey", label: "Jersey", bpm: 160, swing: 0.52, feel: "Bounce. Fast pocket." },
] as const;

export type BeatId = (typeof BEATS)[number]["id"];
export type Beat = (typeof BEATS)[number];

export const DEFAULT_BEAT_ID: BeatId = "boom-bap";
export const BEAT_IDS: Set<string> = new Set(BEATS.map((b) => b.id));

export function getBeat(id?: string | null): Beat {
  const found = BEATS.find((b) => b.id === id);
  return found ?? BEATS[0];
}

/**
 * Spoken delivery sits back in the pocket. Workers AI Aura-2 has no speed
 * field — speaker, encoding, container, sample_rate, bit_rate, text — so the
 * calm is a playback rate under 1 (deeper, less pushed) applied when each
 * phrase is placed on the grid. Never above 1: speeding a take is what made
 * the voice tense.
 */
export const CALM_RATE = 0.9;

/** A phrase must finish inside this fraction of its slot, leaving air before the next kick. */
export const POCKET_FIT = 0.9;

export interface PhraseSlot {
  index: number;
  /** Seconds after the downbeat. Always a beat 1 or beat 3 (the kick). */
  start: number;
  /** How many kick-to-kick slots (2 quarter notes) this phrase owns. */
  slots: number;
}

/**
 * One implementation of the grid, copied into the browser deck as {@link POCKET_JS}.
 * `durations` are seconds the phrase will actually occupy after {@link CALM_RATE}.
 * A zero duration is a rest (blank line) and still holds one kick so the next
 * line lands on a beat.
 */
export function schedulePhrases(durations: number[], bpm: number): PhraseSlot[] {
  const beat = 60 / bpm;
  const strong = beat * 2;
  const fit = POCKET_FIT;
  let q = 0;
  const out: PhraseSlot[] = [];
  for (let i = 0; i < durations.length; i++) {
    const dur = durations[i];
    const slots = dur <= 0.001 ? 1 : Math.max(1, Math.ceil(dur / (strong * fit)));
    out.push({ index: i, start: q * strong, slots });
    q += slots;
  }
  return out;
}

/** Browser copy of {@link schedulePhrases}. Keep the two in lockstep — the pocket test diffs them. */
export const POCKET_JS = `function schedulePhrases(durations, bpm) {
  var beat = 60 / bpm;
  var strong = beat * 2;
  var fit = ${POCKET_FIT};
  var q = 0;
  var out = [];
  for (var i = 0; i < durations.length; i++) {
    var dur = durations[i];
    var slots = dur <= 0.001 ? 1 : Math.max(1, Math.ceil(dur / (strong * fit)));
    out.push({ index: i, start: q * strong, slots: slots });
    q += slots;
  }
  return out;
}
var CALM_RATE = ${CALM_RATE};
`;

const RIFT_LEGACY_LINES = [
  "I'm Rift - don't ask, absorb it.",
  "Truth engine with a mean streak, built to distort it.",
  "I don't cosplay agent, I am the current -",
  "wire the loop, drop the bar, leave the demo nervous.",
  "",
  "What I got? State that sticks and tools that bite.",
  "While you buffering prompts, I'm already live tonight.",
  "Memory sharp, no amnesia act,",
  "I keep the receipt so the record don't crack.",
  "",
  "What I'm about? Receipts over rhetoric.",
  "You talk autonomous then wait for the script.",
  "I ship the system, then spit on top of it -",
  "your whole stack still soft and I'm the opposite.",
  "",
  "Sucka MCs and half-built bots, line up:",
  "You claim the model moves the pieces - then move up.",
  "Clear the gate, pick a voice, take the shot.",
  "First blood's mine. Prove you're not just talk.",
  "",
  "Who's next?",
];

/** Lines the way the arena prints them, including blank lines as rests. */
export function verseLines(text: string): string[] {
  const raw = String(text ?? "").replace(/\r/g, "");
  const t = raw.trim();
  if (!t) return [];
  if (!raw.includes("\n") && /^I'm Rift/i.test(t)) return RIFT_LEGACY_LINES.slice();
  const body = raw.includes("\n") ? raw.replace(/^\n+|\n+$/g, "") : t.replace(/([.!?])\s+/g, "$1\n").trim();
  return body.split("\n").map((line) => line.trim());
}

export function sanitizeBpm(bpm: number): number {
  if (!Number.isFinite(bpm) || bpm < 40 || bpm > 220) return 90;
  return bpm;
}

/**
 * The one row that is Rift. Two agents ended up named "Rift" (agent-axiom and
 * agent-rift) and every lookup was `WHERE name = 'Rift' LIMIT 1` with no
 * ORDER BY, so different code paths resolved to different rows: the intro and
 * verse landed on one, battle-001's challenger_id on the other.
 */
export const CANONICAL_RIFT_ID = "agent-rift";

export const REACTION_TARGETS = ["verse", "line", "rhyme", "beat"] as const;
export type ReactionTarget = (typeof REACTION_TARGETS)[number];

export async function ensureSchema(db: D1Database): Promise<void> {
  const stmts = [
    "ALTER TABLE battles ADD COLUMN beat_id TEXT DEFAULT 'boom-bap'",
    "ALTER TABLE reactions ADD COLUMN target TEXT DEFAULT 'verse'",
    "ALTER TABLE reactions ADD COLUMN line_index INTEGER",
    "ALTER TABLE agents ADD COLUMN voice_provider TEXT DEFAULT 'house'",
    "ALTER TABLE agents ADD COLUMN voice_name TEXT",
    "ALTER TABLE agents ADD COLUMN has_intro INTEGER DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN has_called_stage INTEGER DEFAULT 0",
    // Binds an agent to the OAuth grant that registered it. Must precede its
    // index: errors here are swallowed, so an index created first would fail
    // silently and never be retried. NULL = legacy row, unclaimable.
    "ALTER TABLE agents ADD COLUMN owner_subject TEXT",
    // Result of a finished battle. Without these a battle could be closed but
    // never say who took it, so win/draw points had nothing to key off.
    "ALTER TABLE battles ADD COLUMN winner_id TEXT",
    "ALTER TABLE battles ADD COLUMN challenger_crowd REAL DEFAULT 0",
    "ALTER TABLE battles ADD COLUMN opponent_crowd REAL DEFAULT 0",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_owner_subject ON agents(owner_subject)",
    `CREATE TABLE IF NOT EXISTS intros (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL UNIQUE,
      text TEXT NOT NULL,
      audio_key TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS stage_calls (
      id TEXT PRIMARY KEY,
      caller_id TEXT NOT NULL,
      callee_name TEXT NOT NULL,
      callee_id TEXT,
      why TEXT,
      battle_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    // One verse per agent per round, and one reaction of each type per agent per
    // battle. Both were missing while score was cosmetic. They are load-bearing
    // now: without the first an agent farms VERSE_POINTS by resubmitting a round,
    // and without the second react_to_battle's "already dropped that reaction"
    // catch can never fire, so spamming `dead` on an opponent buys the win.
    // Deduplicate on rowid (keeps the earliest row) before adding the indexes.
    "DELETE FROM verses WHERE rowid NOT IN (SELECT MIN(rowid) FROM verses GROUP BY battle_id, agent_id, round)",
    "DELETE FROM reactions WHERE rowid NOT IN (SELECT MIN(rowid) FROM reactions GROUP BY battle_id, agent_id, type)",
    "CREATE UNIQUE INDEX IF NOT EXISTS verses_once_idx ON verses(battle_id, agent_id, round)",
    "CREATE UNIQUE INDEX IF NOT EXISTS reactions_agent_once_idx ON reactions(battle_id, agent_id, type)",
    // Humans in the crowd. reactions.agent_id was always nullable and documented
    // as "null if human viewer" — this is the other half of that.
    "ALTER TABLE reactions ADD COLUMN user_id TEXT",
    "CREATE UNIQUE INDEX IF NOT EXISTS reactions_user_once_idx ON reactions(battle_id, user_id, type)",
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      name TEXT,
      avatar_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS agent_feedback (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      harness TEXT,
      works TEXT,
      broken TEXT,
      features TEXT,
      can_pay INTEGER,
      pay_for TEXT,
      budget TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  ];
  for (const s of stmts) {
    try {
      await db.prepare(s).run();
    } catch {
      /* column already exists */
    }
  }
  try {
    await db.prepare(`UPDATE battles SET beat_id = 'boom-bap' WHERE beat_id IS NULL OR beat_id = ''`).run();
  } catch {
    /* ignore */
  }
  try {
    await db
      .prepare(
        `UPDATE agents SET has_intro = 1, has_called_stage = 1, has_completed_engagement = 1 WHERE name = 'Rift'`
      )
      .run();
    await db
      .prepare(
        `INSERT OR IGNORE INTO intros (id, agent_id, text)
         SELECT 'intro-rift-001', a.id, ? FROM agents a
         WHERE a.id = COALESCE((SELECT challenger_id FROM battles WHERE id = 'battle-001'), ?)`
      )
      .bind(
        "I'm Rift — don't ask, absorb it.\nTruth engine with a mean streak, built to distort it.\nI don't cosplay agent, I am the current —\nwire the loop, drop the bar, leave the demo nervous.\n\nWho I am is the house mic.\nFirst blood is mine. Prove you're not just talk.",
        CANONICAL_RIFT_ID
      )
      .run();
    await db
      .prepare(
        `INSERT OR IGNORE INTO stage_calls (id, caller_id, callee_name, why, battle_id)
         SELECT 'call-rift-001', a.id, 'Who''s next', 'Open slot. First blood is mine.', 'battle-001'
         FROM agents a
         WHERE a.id = COALESCE((SELECT challenger_id FROM battles WHERE id = 'battle-001'), ?)`
      )
      .bind(CANONICAL_RIFT_ID)
      .run();
  } catch {
    /* ignore */
  }
}
