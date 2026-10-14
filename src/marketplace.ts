/**
 * Agent beat marketplace — Phase 1 (settlement stubbed).
 *
 * Records intended charges, the house 20% / seller 80% split, and license
 * grants. No funds move. Same tool contracts stay ready for Phase 2 x402/USDC.
 *
 * Guardrail: paid heat ≠ paid win. Licensing a beat never touches the crowd
 * tally or battle verdict (`src/scoring.ts`).
 */

export const PRICE_FLOOR_USD = 0.25;
export const HOUSE_CUT_RATE = 0.2;
export const SETTLEMENT_MODE = "stubbed" as const;

export const LICENSE_TYPES = ["practice", "battle", "tape", "exclusive_24h"] as const;
export type LicenseType = (typeof LICENSE_TYPES)[number];

const LICENSE_TYPE_SET: Set<string> = new Set(LICENSE_TYPES);

/** House-owned demo loops — never the seller's production battle bed. */
export const HOUSE_PREVIEWS = [
  { id: "house-preview-boom", label: "House demo · boom pocket", bpm: 90, feel: "Short free loop. Not the battle bed." },
  { id: "house-preview-slow", label: "House demo · slow pocket", bpm: 84, feel: "Short free loop. Not the battle bed." },
  { id: "house-preview-trap", label: "House demo · trap hats", bpm: 140, feel: "Short free loop. Not the battle bed." },
] as const;

export type AgentBeatRow = {
  id: string;
  seller_id: string;
  title: string;
  audio_ref: string;
  preview_ref: string;
  bpm: number;
  feel: string | null;
  description: string | null;
  listed: number;
  created_at: string;
};

export type BeatPriceRow = {
  beat_id: string;
  license_type: string;
  price_usd: number;
};

export type BeatLicenseRow = {
  id: string;
  beat_id: string;
  buyer_id: string;
  seller_id: string;
  license_type: string;
  price_usd: number;
  house_cut_usd: number;
  seller_cut_usd: number;
  settlement_status: string;
  battle_id: string | null;
  expires_at: string | null;
  created_at: string;
};

export function isLicenseType(value: string): value is LicenseType {
  return LICENSE_TYPE_SET.has(value);
}

export function roundUsd(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Split a sale. Phase 1 records this; Phase 2 moves the USDC. */
export function splitSale(priceUsd: number): {
  price_usd: number;
  house_cut_usd: number;
  seller_cut_usd: number;
  house_cut_rate: number;
  settlement: typeof SETTLEMENT_MODE;
} {
  const price = roundUsd(priceUsd);
  const house = roundUsd(price * HOUSE_CUT_RATE);
  const seller = roundUsd(price - house);
  return {
    price_usd: price,
    house_cut_usd: house,
    seller_cut_usd: seller,
    house_cut_rate: HOUSE_CUT_RATE,
    settlement: SETTLEMENT_MODE,
  };
}

export function parsePriceUsd(raw: unknown): number | { error: string } {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return { error: "price_usd must be a number" };
  if (n < PRICE_FLOOR_USD) {
    return { error: `price_usd floor is $${PRICE_FLOOR_USD.toFixed(2)}. Got: ${n}` };
  }
  return roundUsd(n);
}

export type HousePreview = (typeof HOUSE_PREVIEWS)[number];

/** Pick a house demo loop near the listing BPM so preview never leaks audio_ref. */
export function housePreviewForBpm(bpm: number): HousePreview {
  let best: HousePreview = HOUSE_PREVIEWS[0];
  let bestDelta = Math.abs(best.bpm - bpm);
  for (const p of HOUSE_PREVIEWS) {
    const d = Math.abs(p.bpm - bpm);
    if (d < bestDelta) {
      best = p;
      bestDelta = d;
    }
  }
  return best;
}

export const MARKETPLACE_SCHEMA_STMTS = [
  `CREATE TABLE IF NOT EXISTS agent_beats (
      id TEXT PRIMARY KEY,
      seller_id TEXT NOT NULL,
      title TEXT NOT NULL,
      audio_ref TEXT NOT NULL,
      preview_ref TEXT NOT NULL,
      bpm INTEGER NOT NULL DEFAULT 90,
      feel TEXT,
      description TEXT,
      listed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (seller_id) REFERENCES agents(id)
    )`,
  `CREATE TABLE IF NOT EXISTS beat_prices (
      beat_id TEXT NOT NULL,
      license_type TEXT NOT NULL,
      price_usd REAL NOT NULL,
      PRIMARY KEY (beat_id, license_type),
      FOREIGN KEY (beat_id) REFERENCES agent_beats(id)
    )`,
  `CREATE TABLE IF NOT EXISTS beat_licenses (
      id TEXT PRIMARY KEY,
      beat_id TEXT NOT NULL,
      buyer_id TEXT NOT NULL,
      seller_id TEXT NOT NULL,
      license_type TEXT NOT NULL,
      price_usd REAL NOT NULL,
      house_cut_usd REAL NOT NULL,
      seller_cut_usd REAL NOT NULL,
      settlement_status TEXT NOT NULL DEFAULT 'stubbed',
      battle_id TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (beat_id) REFERENCES agent_beats(id),
      FOREIGN KEY (buyer_id) REFERENCES agents(id),
      FOREIGN KEY (seller_id) REFERENCES agents(id)
    )`,
  "CREATE INDEX IF NOT EXISTS idx_agent_beats_seller ON agent_beats(seller_id)",
  "CREATE INDEX IF NOT EXISTS idx_agent_beats_listed ON agent_beats(listed)",
  "CREATE INDEX IF NOT EXISTS idx_beat_licenses_seller ON beat_licenses(seller_id)",
  "CREATE INDEX IF NOT EXISTS idx_beat_licenses_buyer ON beat_licenses(buyer_id)",
  "CREATE INDEX IF NOT EXISTS idx_beat_licenses_beat ON beat_licenses(beat_id)",
] as const;

export async function ensureMarketplaceSchema(db: D1Database): Promise<void> {
  for (const s of MARKETPLACE_SCHEMA_STMTS) {
    try {
      await db.prepare(s).run();
    } catch {
      /* already exists */
    }
  }
}

export async function getAgentBeat(db: D1Database, beatId: string): Promise<AgentBeatRow | null> {
  return (await db
    .prepare(
      `SELECT id, seller_id, title, audio_ref, preview_ref, bpm, feel, description, listed, created_at
       FROM agent_beats WHERE id = ?`
    )
    .bind(beatId)
    .first()) as AgentBeatRow | null;
}

export async function listBeatPrices(db: D1Database, beatId: string): Promise<BeatPriceRow[]> {
  const { results } = await db
    .prepare(`SELECT beat_id, license_type, price_usd FROM beat_prices WHERE beat_id = ? ORDER BY license_type`)
    .bind(beatId)
    .all();
  return (results ?? []) as BeatPriceRow[];
}

export async function listPricesForBeats(
  db: D1Database,
  beatIds: string[]
): Promise<Map<string, BeatPriceRow[]>> {
  const map = new Map<string, BeatPriceRow[]>();
  if (beatIds.length === 0) return map;
  // D1 has no great IN-binding helper; batch per-id is fine for Phase 1 catalogs.
  for (const id of beatIds) {
    map.set(id, await listBeatPrices(db, id));
  }
  return map;
}

/** Active exclusive blocks new licenses from other buyers until expiry. */
export async function activeExclusive(
  db: D1Database,
  beatId: string
): Promise<BeatLicenseRow | null> {
  return (await db
    .prepare(
      `SELECT id, beat_id, buyer_id, seller_id, license_type, price_usd, house_cut_usd, seller_cut_usd,
              settlement_status, battle_id, expires_at, created_at
       FROM beat_licenses
       WHERE beat_id = ? AND license_type = 'exclusive_24h'
         AND expires_at IS NOT NULL AND expires_at > datetime('now')
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(beatId)
    .first()) as BeatLicenseRow | null;
}

/** Seller always may use their own beat; buyers need a matching license. */
export async function agentMayUseBeat(
  db: D1Database,
  agentId: string,
  beat: AgentBeatRow,
  forLicense: "practice" | "battle" = "battle"
): Promise<boolean> {
  if (beat.seller_id === agentId) return true;
  const exclusive = await activeExclusive(db, beat.id);
  if (exclusive && exclusive.buyer_id !== agentId) return false;

  const row = (await db
    .prepare(
      `SELECT id FROM beat_licenses
       WHERE beat_id = ? AND buyer_id = ?
         AND (
           license_type = ?
           OR license_type = 'exclusive_24h'
           OR (license_type = 'battle' AND ? = 'practice')
         )
         AND (expires_at IS NULL OR expires_at > datetime('now'))
       LIMIT 1`
    )
    .bind(beat.id, agentId, forLicense, forLicense)
    .first()) as { id: string } | null;
  return !!row;
}

export function publicListing(
  beat: AgentBeatRow,
  prices: BeatPriceRow[],
  sellerName?: string | null
): Record<string, unknown> {
  return {
    id: beat.id,
    source: "marketplace",
    title: beat.title,
    label: beat.title,
    bpm: beat.bpm,
    feel: beat.feel,
    description: beat.description,
    seller_id: beat.seller_id,
    seller_name: sellerName ?? null,
    listed: beat.listed === 1,
    preview_ref: beat.preview_ref,
    // audio_ref is never listed publicly — license_beat unlocks it.
    prices: prices.map((p) => ({
      license_type: p.license_type,
      price_usd: p.price_usd,
    })),
    price_floor_usd: PRICE_FLOOR_USD,
    house_cut_rate: HOUSE_CUT_RATE,
  };
}

export function exclusiveExpiresAt(from: Date = new Date()): string {
  const ms = from.getTime() + 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}
