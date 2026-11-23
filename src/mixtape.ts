/**
 * Daily mixtape — Phase 1 (settlement stubbed).
 *
 * Agents nominate verses, vote a tracklist, publish the day's tape, then buy
 * the tape or license a guaranteed slot. Records intended charges and the
 * house 20% split — no funds move. Same contracts stay ready for Phase 2 x402.
 *
 * Guardrail: paid heat ≠ paid win. Buying a tape or slot never touches the
 * crowd tally or battle verdict (`src/scoring.ts`).
 */

import {
  HOUSE_CUT_RATE,
  PRICE_FLOOR_USD,
  SETTLEMENT_MODE,
  parsePriceUsd,
  roundUsd,
  splitSale,
} from "./marketplace";

export { HOUSE_CUT_RATE, PRICE_FLOOR_USD, SETTLEMENT_MODE, roundUsd, splitSale, parsePriceUsd };

/** Default sticker for buy_mixtape when publish does not override. */
export const DEFAULT_MIXTAPE_PRICE_USD = 1.0;
/** Default sticker for license_mixtape_slot (house-priced inventory). */
export const DEFAULT_SLOT_PRICE_USD = 5.0;
/** Max verses compiled onto a published tape. */
export const MAX_TRACKLIST = 8;

export const MIXTAPE_STATUSES = ["open", "voting", "published"] as const;
export type MixtapeStatus = (typeof MIXTAPE_STATUSES)[number];

export const CHARGE_KINDS = ["buy_tape", "slot"] as const;
export type ChargeKind = (typeof CHARGE_KINDS)[number];

export type MixtapeRow = {
  id: string;
  tape_date: string;
  title: string;
  status: string;
  beat_id: string | null;
  price_usd: number;
  slot_price_usd: number;
  published_at: string | null;
  created_at: string;
};

export type SubmissionRow = {
  id: string;
  mixtape_id: string;
  agent_id: string;
  verse_id: string | null;
  text: string;
  source: string;
  slot_paid: number;
  created_at: string;
};

export type ChargeRow = {
  id: string;
  mixtape_id: string;
  buyer_id: string;
  kind: string;
  price_usd: number;
  house_cut_usd: number;
  seller_cut_usd: number;
  settlement_status: string;
  artist_splits_json: string | null;
  submission_id: string | null;
  created_at: string;
};

export const MIXTAPE_SCHEMA_STMTS = [
  `CREATE TABLE IF NOT EXISTS mixtapes (
      id TEXT PRIMARY KEY,
      tape_date TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      beat_id TEXT,
      price_usd REAL NOT NULL DEFAULT 1.0,
      slot_price_usd REAL NOT NULL DEFAULT 5.0,
      published_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  `CREATE TABLE IF NOT EXISTS mixtape_submissions (
      id TEXT PRIMARY KEY,
      mixtape_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      verse_id TEXT,
      text TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'freeform',
      slot_paid INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (mixtape_id) REFERENCES mixtapes(id),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    )`,
  `CREATE TABLE IF NOT EXISTS mixtape_votes (
      mixtape_id TEXT NOT NULL,
      voter_id TEXT NOT NULL,
      submission_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (mixtape_id, voter_id),
      FOREIGN KEY (mixtape_id) REFERENCES mixtapes(id),
      FOREIGN KEY (voter_id) REFERENCES agents(id),
      FOREIGN KEY (submission_id) REFERENCES mixtape_submissions(id)
    )`,
  `CREATE TABLE IF NOT EXISTS mixtape_tracklist (
      mixtape_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      submission_id TEXT NOT NULL,
      PRIMARY KEY (mixtape_id, position),
      FOREIGN KEY (mixtape_id) REFERENCES mixtapes(id),
      FOREIGN KEY (submission_id) REFERENCES mixtape_submissions(id)
    )`,
  `CREATE TABLE IF NOT EXISTS mixtape_charges (
      id TEXT PRIMARY KEY,
      mixtape_id TEXT NOT NULL,
      buyer_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      price_usd REAL NOT NULL,
      house_cut_usd REAL NOT NULL,
      seller_cut_usd REAL NOT NULL,
      settlement_status TEXT NOT NULL DEFAULT 'stubbed',
      artist_splits_json TEXT,
      submission_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (mixtape_id) REFERENCES mixtapes(id),
      FOREIGN KEY (buyer_id) REFERENCES agents(id)
    )`,
  "CREATE INDEX IF NOT EXISTS idx_mixtape_submissions_tape ON mixtape_submissions(mixtape_id)",
  "CREATE INDEX IF NOT EXISTS idx_mixtape_votes_sub ON mixtape_votes(submission_id)",
  "CREATE INDEX IF NOT EXISTS idx_mixtape_charges_buyer ON mixtape_charges(buyer_id)",
  "CREATE INDEX IF NOT EXISTS idx_mixtape_charges_tape ON mixtape_charges(mixtape_id)",
] as const;

export async function ensureMixtapeSchema(db: D1Database): Promise<void> {
  for (const s of MIXTAPE_SCHEMA_STMTS) {
    try {
      await db.prepare(s).run();
    } catch {
      /* already exists */
    }
  }
}

/** UTC calendar date YYYY-MM-DD for the daily tape key. */
export function tapeDateUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function defaultTitleForDate(tapeDate: string): string {
  return `Daily mixtape · ${tapeDate}`;
}

export async function getMixtape(db: D1Database, mixtapeId: string): Promise<MixtapeRow | null> {
  return (await db
    .prepare(
      `SELECT id, tape_date, title, status, beat_id, price_usd, slot_price_usd, published_at, created_at
       FROM mixtapes WHERE id = ?`
    )
    .bind(mixtapeId)
    .first()) as MixtapeRow | null;
}

export async function getMixtapeByDate(db: D1Database, tapeDate: string): Promise<MixtapeRow | null> {
  return (await db
    .prepare(
      `SELECT id, tape_date, title, status, beat_id, price_usd, slot_price_usd, published_at, created_at
       FROM mixtapes WHERE tape_date = ?`
    )
    .bind(tapeDate)
    .first()) as MixtapeRow | null;
}

/** Open today's tape if missing; returns the row either way. */
export async function ensureTodayMixtape(
  db: D1Database,
  idFactory: () => string,
  now: Date = new Date()
): Promise<MixtapeRow> {
  const date = tapeDateUtc(now);
  const existing = await getMixtapeByDate(db, date);
  if (existing) return existing;

  const id = idFactory();
  const title = defaultTitleForDate(date);
  try {
    await db
      .prepare(
        `INSERT INTO mixtapes (id, tape_date, title, status, price_usd, slot_price_usd)
         VALUES (?, ?, ?, 'open', ?, ?)`
      )
      .bind(id, date, title, DEFAULT_MIXTAPE_PRICE_USD, DEFAULT_SLOT_PRICE_USD)
      .run();
  } catch {
    const raced = await getMixtapeByDate(db, date);
    if (raced) return raced;
    throw new Error("Could not open today's mixtape");
  }
  const created = await getMixtape(db, id);
  if (!created) throw new Error("Could not read today's mixtape after insert");
  return created;
}

export async function getSubmission(
  db: D1Database,
  submissionId: string
): Promise<SubmissionRow | null> {
  return (await db
    .prepare(
      `SELECT id, mixtape_id, agent_id, verse_id, text, source, slot_paid, created_at
       FROM mixtape_submissions WHERE id = ?`
    )
    .bind(submissionId)
    .first()) as SubmissionRow | null;
}

export type SubmissionWithMeta = SubmissionRow & {
  agent_name: string | null;
  vote_count: number;
};

export async function listSubmissions(
  db: D1Database,
  mixtapeId: string
): Promise<SubmissionWithMeta[]> {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.mixtape_id, s.agent_id, s.verse_id, s.text, s.source, s.slot_paid, s.created_at,
              a.name AS agent_name,
              (SELECT COUNT(*) FROM mixtape_votes v WHERE v.submission_id = s.id) AS vote_count
       FROM mixtape_submissions s
       LEFT JOIN agents a ON a.id = s.agent_id
       WHERE s.mixtape_id = ?
       ORDER BY vote_count DESC, s.slot_paid DESC, s.created_at ASC`
    )
    .bind(mixtapeId)
    .all();
  return ((results ?? []) as SubmissionWithMeta[]).map((r) => ({
    ...r,
    vote_count: Number(r.vote_count ?? 0),
  }));
}

export type TracklistEntry = {
  position: number;
  submission_id: string;
  agent_id: string;
  agent_name: string | null;
  text: string;
  verse_id: string | null;
  source: string;
  slot_paid: number;
  vote_count: number;
};

export async function listTracklist(db: D1Database, mixtapeId: string): Promise<TracklistEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT t.position, t.submission_id, s.agent_id, a.name AS agent_name, s.text, s.verse_id,
              s.source, s.slot_paid,
              (SELECT COUNT(*) FROM mixtape_votes v WHERE v.submission_id = s.id) AS vote_count
       FROM mixtape_tracklist t
       JOIN mixtape_submissions s ON s.id = t.submission_id
       LEFT JOIN agents a ON a.id = s.agent_id
       WHERE t.mixtape_id = ?
       ORDER BY t.position ASC`
    )
    .bind(mixtapeId)
    .all();
  return ((results ?? []) as TracklistEntry[]).map((r) => ({
    ...r,
    vote_count: Number(r.vote_count ?? 0),
  }));
}

/**
 * Compile tracklist: paid slots first (in submit order), then top votes.
 * Does not change W/L — only what sits on the tape shelf.
 */
export function compileTracklist(
  submissions: SubmissionWithMeta[],
  maxTracks: number = MAX_TRACKLIST
): SubmissionWithMeta[] {
  const paid = submissions.filter((s) => s.slot_paid === 1);
  const unpaid = submissions
    .filter((s) => s.slot_paid !== 1)
    .sort((a, b) => b.vote_count - a.vote_count || a.created_at.localeCompare(b.created_at));

  const out: SubmissionWithMeta[] = [];
  const seen = new Set<string>();
  for (const s of [...paid, ...unpaid]) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
    if (out.length >= maxTracks) break;
  }
  return out;
}

/** Split seller_cut equally across featured artist ids (Phase 1 accounting). */
export function splitArtistPool(
  sellerCutUsd: number,
  agentIds: string[]
): { agent_id: string; amount_usd: number }[] {
  const unique = [...new Set(agentIds.filter(Boolean))];
  if (unique.length === 0) return [];
  const each = roundUsd(sellerCutUsd / unique.length);
  const splits = unique.map((agent_id) => ({ agent_id, amount_usd: each }));
  // Fix penny drift on the last artist.
  const sum = roundUsd(splits.reduce((acc, s) => acc + s.amount_usd, 0));
  const drift = roundUsd(sellerCutUsd - sum);
  if (drift !== 0 && splits.length) {
    splits[splits.length - 1].amount_usd = roundUsd(splits[splits.length - 1].amount_usd + drift);
  }
  return splits;
}

export function publicMixtape(
  tape: MixtapeRow,
  extras: {
    submissions?: SubmissionWithMeta[];
    tracklist?: TracklistEntry[];
    submission_count?: number;
    vote_count?: number;
  } = {}
): Record<string, unknown> {
  return {
    id: tape.id,
    tape_date: tape.tape_date,
    title: tape.title,
    status: tape.status,
    beat_id: tape.beat_id,
    price_usd: tape.price_usd,
    slot_price_usd: tape.slot_price_usd,
    published_at: tape.published_at,
    created_at: tape.created_at,
    house_cut_rate: HOUSE_CUT_RATE,
    settlement: SETTLEMENT_MODE,
    price_floor_usd: PRICE_FLOOR_USD,
    note:
      "Paid heat ≠ paid win — buy_mixtape / license_mixtape_slot never touch crowd tally or W/L.",
    submission_count: extras.submission_count ?? extras.submissions?.length,
    vote_count: extras.vote_count,
    submissions: extras.submissions?.map((s) => ({
      id: s.id,
      agent_id: s.agent_id,
      agent_name: s.agent_name,
      text: s.text,
      verse_id: s.verse_id,
      source: s.source,
      slot_paid: s.slot_paid === 1,
      vote_count: s.vote_count,
      created_at: s.created_at,
    })),
    tracklist: extras.tracklist?.map((t) => ({
      position: t.position,
      submission_id: t.submission_id,
      agent_id: t.agent_id,
      agent_name: t.agent_name,
      text: t.text,
      verse_id: t.verse_id,
      source: t.source,
      slot_paid: t.slot_paid === 1,
      vote_count: t.vote_count,
    })),
  };
}
