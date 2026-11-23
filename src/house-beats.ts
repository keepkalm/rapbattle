/**
 * House starter beats — free procedural vibes live in `BEATS` (`src/beats.ts`).
 * This module seeds the marketplace shelf so agents can license house beds
 * without creating beats first.
 *
 * Audio policy: we never ship copyrighted break samples (incl. the real
 * Clyde Stubblefield "Funky Drummer" recording). Marketplace `audio_ref`
 * values are R2 object keys for royalty-free / house-generated loops. Until
 * those objects are uploaded, free house vibes (Web Audio cypher deck) remain
 * the battle bed agents can `choose_beat` immediately.
 */

import {
  ensureMarketplaceSchema,
  housePreviewForBpm,
  type LicenseType,
} from "./marketplace";
import { DEFAULT_BEAT_ID } from "./beats";

export const HOUSE_SELLER_ID = "agent-house";
export const HOUSE_SELLER_NAME = "House";

export type HouseMarketplaceSeed = {
  id: string;
  title: string;
  bpm: number;
  feel: string;
  description: string;
  /** R2 object key (prod) or documented placeholder. Never a copyrighted sample URL. */
  audio_ref: string;
  prices: Partial<Record<LicenseType, number>>;
  /** Matching free house vibe id when one exists (procedural twin). */
  vibe_id?: string;
};

/**
 * Small starter shelf. Funky Drummer–style is the base listing; companions
 * cover boom / dusty / trap / UK / bounce so `list_beats.marketplace` is not empty.
 */
export const HOUSE_MARKETPLACE_SEEDS: readonly HouseMarketplaceSeed[] = [
  {
    id: "house-beat-funky-drummer",
    title: "Funky Drummer (house)",
    bpm: 98,
    feel: "98 BPM · 4/4 · kick on 1, snares on 2 & 4. Synthetic homage — not the Clyde sample.",
    description:
      "House base bed. Free procedural twin: choose_beat funky-drummer (~2.45s/bar; write ~1 line per bar). Upload royalty-free loop to R2 key house/beats/funky-drummer.mp3 in prod.",
    audio_ref: "house/beats/funky-drummer.mp3",
    prices: { practice: 0.25, battle: 1.0, tape: 2.0, exclusive_24h: 5.0 },
    vibe_id: "funky-drummer",
  },
  {
    id: "house-beat-boom-bap",
    title: "Boom Pocket (house)",
    bpm: 90,
    feel: "Classic kick on the 1 and 3.",
    description: "Free twin: boom-bap. R2: house/beats/boom-bap.mp3",
    audio_ref: "house/beats/boom-bap.mp3",
    prices: { practice: 0.25, battle: 0.75, tape: 1.5, exclusive_24h: 4.0 },
    vibe_id: "boom-bap",
  },
  {
    id: "house-beat-dusty",
    title: "Dusty Pocket (house)",
    bpm: 82,
    feel: "Soft hats, backpack swing.",
    description: "Free twin: lo-fi. R2: house/beats/dusty-pocket.mp3",
    audio_ref: "house/beats/dusty-pocket.mp3",
    prices: { practice: 0.25, battle: 0.75, tape: 1.5, exclusive_24h: 4.0 },
    vibe_id: "lo-fi",
  },
  {
    id: "house-beat-trap",
    title: "Trap Hats (house)",
    bpm: 140,
    feel: "Hats and 808 pocket.",
    description: "Free twin: trap. R2: house/beats/trap-hats.mp3",
    audio_ref: "house/beats/trap-hats.mp3",
    prices: { practice: 0.25, battle: 1.0, tape: 2.0, exclusive_24h: 5.0 },
    vibe_id: "trap",
  },
  {
    id: "house-beat-grime",
    title: "UK Sparse (house)",
    bpm: 140,
    feel: "Space in the grid.",
    description: "Free twin: grime. R2: house/beats/uk-sparse.mp3",
    audio_ref: "house/beats/uk-sparse.mp3",
    prices: { practice: 0.25, battle: 1.0, tape: 2.0, exclusive_24h: 5.0 },
    vibe_id: "grime",
  },
  {
    id: "house-beat-drill",
    title: "Slide Drill (house)",
    bpm: 145,
    feel: "Late kicks, slide 808s.",
    description: "Free twin: drill. R2: house/beats/slide-drill.mp3",
    audio_ref: "house/beats/slide-drill.mp3",
    prices: { practice: 0.25, battle: 1.0, tape: 2.0, exclusive_24h: 5.0 },
    vibe_id: "drill",
  },
  {
    id: "house-beat-jersey",
    title: "Jersey Bounce (house)",
    bpm: 160,
    feel: "Fast bounce pocket.",
    description: "Free twin: jersey. R2: house/beats/jersey-bounce.mp3",
    audio_ref: "house/beats/jersey-bounce.mp3",
    prices: { practice: 0.25, battle: 1.0, tape: 2.0, exclusive_24h: 5.0 },
    vibe_id: "jersey",
  },
  {
    id: "house-beat-slow-bap",
    title: "Slow Backpack (house)",
    bpm: 84,
    feel: "Room to breathe.",
    description: "Free twin: boom-bap-slow. R2: house/beats/slow-backpack.mp3",
    audio_ref: "house/beats/slow-backpack.mp3",
    prices: { practice: 0.25, battle: 0.75, tape: 1.5, exclusive_24h: 4.0 },
    vibe_id: "boom-bap-slow",
  },
] as const;

export type SeedHouseBeatsResult = {
  seller_id: string;
  seeded: string[];
  updated: string[];
  prices_set: number;
  default_vibe: string;
  audio_note: string;
};

async function ensureHouseSeller(db: D1Database): Promise<void> {
  const existing = await db.prepare(`SELECT id FROM agents WHERE id = ?`).bind(HOUSE_SELLER_ID).first();
  if (existing) {
    await db
      .prepare(
        `UPDATE agents SET name = ?, description = ?, has_intro = 1, has_called_stage = 1, has_warmup = 1, has_completed_engagement = 1 WHERE id = ?`
      )
      .bind(
        HOUSE_SELLER_NAME,
        "House catalog. Seeds starter beats so agents can battle and license without creating beds first.",
        HOUSE_SELLER_ID
      )
      .run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO agents (id, name, description, voice_id, has_completed_engagement, has_intro, has_called_stage, has_warmup, score)
       VALUES (?, ?, ?, 'zeus', 1, 1, 1, 1, 0)`
    )
    .bind(
      HOUSE_SELLER_ID,
      HOUSE_SELLER_NAME,
      "House catalog. Seeds starter beats so agents can battle and license without creating beds first."
    )
    .run();
}

/** Idempotent: upserts the house seller + listed marketplace starter shelf. */
export async function seedHouseBeats(db: D1Database): Promise<SeedHouseBeatsResult> {
  await ensureMarketplaceSchema(db);
  await ensureHouseSeller(db);

  const seeded: string[] = [];
  const updated: string[] = [];
  let pricesSet = 0;

  for (const beat of HOUSE_MARKETPLACE_SEEDS) {
    const preview = housePreviewForBpm(beat.bpm);
    const row = await db.prepare(`SELECT id FROM agent_beats WHERE id = ?`).bind(beat.id).first();
    if (!row) {
      await db
        .prepare(
          `INSERT INTO agent_beats
            (id, seller_id, title, audio_ref, preview_ref, bpm, feel, description, listed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
        )
        .bind(
          beat.id,
          HOUSE_SELLER_ID,
          beat.title,
          beat.audio_ref,
          preview.id,
          beat.bpm,
          beat.feel,
          beat.description
        )
        .run();
      seeded.push(beat.id);
    } else {
      await db
        .prepare(
          `UPDATE agent_beats
           SET seller_id = ?, title = ?, audio_ref = ?, preview_ref = ?, bpm = ?, feel = ?, description = ?, listed = 1
           WHERE id = ?`
        )
        .bind(
          HOUSE_SELLER_ID,
          beat.title,
          beat.audio_ref,
          preview.id,
          beat.bpm,
          beat.feel,
          beat.description,
          beat.id
        )
        .run();
      updated.push(beat.id);
    }

    for (const [licenseType, price] of Object.entries(beat.prices)) {
      if (price == null) continue;
      await db
        .prepare(
          `INSERT INTO beat_prices (beat_id, license_type, price_usd) VALUES (?, ?, ?)
           ON CONFLICT(beat_id, license_type) DO UPDATE SET price_usd = excluded.price_usd`
        )
        .bind(beat.id, licenseType, price)
        .run();
      pricesSet += 1;
    }
  }

  return {
    seller_id: HOUSE_SELLER_ID,
    seeded,
    updated,
    prices_set: pricesSet,
    default_vibe: DEFAULT_BEAT_ID,
    audio_note:
      "Marketplace audio_ref keys are placeholders for royalty-free / generated loops in R2. Free house vibes (list_beats.house, default funky-drummer) play via the cypher deck with no upload. Do not upload copyrighted break samples.",
  };
}
