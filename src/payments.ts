/**
 * Payment intents — Phase 2 dual-rail settlement.
 *
 * Stacks beside Phase 1 stub licenses/charges. Default path stays stubbed;
 * create_payment_intent / get_payment_intent / confirm_payment bridge toward
 * X Money P2P / card / x402 without renaming marketplace or mixtape tools.
 *
 * Thin X Money hook: intent responses include amount, memo (with intent_id),
 * and house payee handle for a later P2P send. No card PAN, no live P2P call.
 */

import {
  HOUSE_CUT_RATE,
  PRICE_FLOOR_USD,
  SETTLEMENT_MODE,
  getAgentBeat,
  isLicenseType,
  parsePriceUsd,
  roundUsd,
  splitSale,
  type LicenseType,
} from "./marketplace";
import {
  DEFAULT_MIXTAPE_PRICE_USD,
  DEFAULT_SLOT_PRICE_USD,
  ensureTodayMixtape,
  getMixtape,
  getMixtapeByDate,
  tapeDateUtc,
} from "./mixtape";

export { HOUSE_CUT_RATE, PRICE_FLOOR_USD, SETTLEMENT_MODE, roundUsd };

/** Rails recorded on intents and on license/charge settlement_status. */
export const SETTLEMENT_RAILS = ["stubbed", "x_money_p2p", "x402", "card"] as const;
export type SettlementRail = (typeof SETTLEMENT_RAILS)[number];

const RAIL_SET: Set<string> = new Set(SETTLEMENT_RAILS);

export const INTENT_SKUS = ["license_beat", "buy_mixtape", "license_mixtape_slot"] as const;
export type IntentSku = (typeof INTENT_SKUS)[number];

const SKU_SET: Set<string> = new Set(INTENT_SKUS);

export const INTENT_STATUSES = ["pending", "confirmed", "fulfilled", "cancelled", "expired"] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

/** Default house X handle for P2P memo copy until ops sets HOUSE_X_HANDLE. */
export const DEFAULT_HOUSE_X_HANDLE = "@rapbattle";

export type PaymentIntentRow = {
  id: string;
  buyer_id: string;
  sku: string;
  target_id: string;
  license_type: string | null;
  amount_usd: number;
  house_cut_usd: number;
  seller_cut_usd: number;
  currency: string;
  settlement_rail: string;
  status: string;
  memo: string;
  payee_handle: string | null;
  external_ref: string | null;
  grant_id: string | null;
  battle_id: string | null;
  meta_json: string | null;
  expires_at: string | null;
  confirmed_at: string | null;
  created_at: string;
};

export type PaymentsEnv = {
  DB: D1Database;
  /** When "1", license/buy tools refuse bare stub grants — require a settled intent. */
  PAYMENTS_REQUIRED?: string;
  /** House @handle for X Money P2P memo copy (thin hook). */
  HOUSE_X_HANDLE?: string;
};

export const PAYMENTS_SCHEMA_STMTS = [
  `CREATE TABLE IF NOT EXISTS payment_intents (
      id TEXT PRIMARY KEY,
      buyer_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      target_id TEXT NOT NULL,
      license_type TEXT,
      amount_usd REAL NOT NULL,
      house_cut_usd REAL NOT NULL,
      seller_cut_usd REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      settlement_rail TEXT NOT NULL DEFAULT 'stubbed',
      status TEXT NOT NULL DEFAULT 'pending',
      memo TEXT NOT NULL,
      payee_handle TEXT,
      external_ref TEXT,
      grant_id TEXT,
      battle_id TEXT,
      meta_json TEXT,
      expires_at TEXT,
      confirmed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (buyer_id) REFERENCES agents(id)
    )`,
  "CREATE INDEX IF NOT EXISTS idx_payment_intents_buyer ON payment_intents(buyer_id)",
  "CREATE INDEX IF NOT EXISTS idx_payment_intents_status ON payment_intents(status)",
  "CREATE INDEX IF NOT EXISTS idx_payment_intents_target ON payment_intents(sku, target_id)",
  "ALTER TABLE beat_licenses ADD COLUMN payment_intent_id TEXT",
  "ALTER TABLE beat_licenses ADD COLUMN external_ref TEXT",
  "ALTER TABLE mixtape_charges ADD COLUMN payment_intent_id TEXT",
  "ALTER TABLE mixtape_charges ADD COLUMN external_ref TEXT",
] as const;

export async function ensurePaymentsSchema(db: D1Database): Promise<void> {
  for (const s of PAYMENTS_SCHEMA_STMTS) {
    try {
      await db.prepare(s).run();
    } catch {
      /* already exists */
    }
  }
}

export function isSettlementRail(value: string): value is SettlementRail {
  return RAIL_SET.has(value);
}

export function isIntentSku(value: string): value is IntentSku {
  return SKU_SET.has(value);
}

export function paymentsRequired(env: PaymentsEnv): boolean {
  return String(env.PAYMENTS_REQUIRED || "") === "1";
}

export function housePayeeHandle(env: PaymentsEnv): string {
  const raw = (env.HOUSE_X_HANDLE || "").trim();
  return raw || DEFAULT_HOUSE_X_HANDLE;
}

export function intentMemo(intentId: string): string {
  return `rapbattle:${intentId}`;
}

export function intentExpiresAt(from: Date = new Date()): string {
  const ms = from.getTime() + 60 * 60 * 1000;
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export function sqlNow(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export async function getPaymentIntent(
  db: D1Database,
  intentId: string
): Promise<PaymentIntentRow | null> {
  return (await db
    .prepare(
      `SELECT id, buyer_id, sku, target_id, license_type, amount_usd, house_cut_usd, seller_cut_usd,
              currency, settlement_rail, status, memo, payee_handle, external_ref, grant_id,
              battle_id, meta_json, expires_at, confirmed_at, created_at
       FROM payment_intents WHERE id = ?`
    )
    .bind(intentId)
    .first()) as PaymentIntentRow | null;
}

/** Public shape returned by MCP tools — never includes card data. */
export function publicIntent(row: PaymentIntentRow): Record<string, unknown> {
  return {
    intent_id: row.id,
    sku: row.sku,
    target_id: row.target_id,
    license_type: row.license_type,
    amount_usd: row.amount_usd,
    house_cut_usd: row.house_cut_usd,
    seller_cut_usd: row.seller_cut_usd,
    house_cut_rate: HOUSE_CUT_RATE,
    currency: row.currency,
    settlement_rail: row.settlement_rail,
    settlement_status: row.settlement_rail,
    status: row.status,
    memo: row.memo,
    payee_handle: row.payee_handle,
    external_ref: row.external_ref,
    grant_id: row.grant_id,
    battle_id: row.battle_id,
    expires_at: row.expires_at,
    confirmed_at: row.confirmed_at,
    created_at: row.created_at,
    meta: row.meta_json ? safeJson(row.meta_json) : null,
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export type QuoteOk = {
  sku: IntentSku;
  target_id: string;
  license_type: string | null;
  amount_usd: number;
  house_cut_usd: number;
  seller_cut_usd: number;
  battle_id: string | null;
  meta: Record<string, unknown>;
};

/**
 * Resolve sticker price for an intent SKU from current catalog rows.
 * Does not create grants — only quotes.
 */
export async function quoteIntentSku(
  env: PaymentsEnv,
  buyerId: string,
  args: {
    sku: string;
    beat_id?: unknown;
    mixtape_id?: unknown;
    tape_date?: unknown;
    license_type?: unknown;
    battle_id?: unknown;
    text?: unknown;
    verse_id?: unknown;
    submission_id?: unknown;
    idFactory: () => string;
  }
): Promise<QuoteOk | { error: string }> {
  const skuRaw = String(args.sku || "").trim();
  // buy_beat is an alias surface for license_beat.
  const sku = skuRaw === "buy_beat" ? "license_beat" : skuRaw;
  if (!isIntentSku(sku)) {
    return { error: `sku must be one of: ${INTENT_SKUS.join(" | ")} (buy_beat aliases license_beat)` };
  }

  if (sku === "license_beat") {
    const beatId = String(args.beat_id || "").trim();
    const licenseType = String(args.license_type || "").trim();
    const battleId =
      args.battle_id == null || args.battle_id === "" ? null : String(args.battle_id);

    if (!beatId) return { error: "beat_id is required for license_beat intents" };
    if (!isLicenseType(licenseType)) {
      return { error: `license_type must be one of: practice | battle | tape | exclusive_24h` };
    }

    const beat = await getAgentBeat(env.DB, beatId);
    if (!beat) return { error: "Marketplace beat not found. House vibes are free — no license needed." };
    if (beat.seller_id === buyerId) return { error: "You already own this beat. No license needed." };
    if (beat.listed !== 1) return { error: "This beat is not listed for sale." };

    const priceRow = (await env.DB.prepare(
      `SELECT price_usd FROM beat_prices WHERE beat_id = ? AND license_type = ?`
    )
      .bind(beatId, licenseType)
      .first()) as { price_usd: number } | null;
    if (!priceRow) {
      return {
        error: `Seller has not priced a '${licenseType}' license. Call list_beats to see offered types.`,
      };
    }

    if (battleId) {
      const battle = (await env.DB.prepare(`SELECT id FROM battles WHERE id = ?`).bind(battleId).first()) as {
        id: string;
      } | null;
      if (!battle) return { error: "battle_id not found" };
    }

    const split = splitSale(Number(priceRow.price_usd));
    return {
      sku,
      target_id: beatId,
      license_type: licenseType as LicenseType,
      amount_usd: split.price_usd,
      house_cut_usd: split.house_cut_usd,
      seller_cut_usd: split.seller_cut_usd,
      battle_id: battleId,
      meta: { title: beat.title, seller_id: beat.seller_id },
    };
  }

  // mixtape SKUs
  let tapeId = args.mixtape_id == null || args.mixtape_id === "" ? null : String(args.mixtape_id);
  if (!tapeId && args.tape_date) {
    const byDate = await getMixtapeByDate(env.DB, String(args.tape_date));
    if (!byDate) return { error: `No mixtape for tape_date ${args.tape_date}` };
    tapeId = byDate.id;
  }

  if (sku === "buy_mixtape") {
    let tape = tapeId ? await getMixtape(env.DB, tapeId) : await getMixtapeByDate(env.DB, tapeDateUtc());
    if (!tape) return { error: "Mixtape not found. Publish today's tape first, or pass mixtape_id." };
    if (tape.status !== "published") {
      return { error: "Mixtape is not published yet. Call publish_mixtape first." };
    }
    const price = Number.isFinite(tape.price_usd) ? tape.price_usd : DEFAULT_MIXTAPE_PRICE_USD;
    const parsed = parsePriceUsd(price);
    if (typeof parsed === "object") return parsed;
    const split = splitSale(parsed);
    return {
      sku,
      target_id: tape.id,
      license_type: null,
      amount_usd: split.price_usd,
      house_cut_usd: split.house_cut_usd,
      seller_cut_usd: split.seller_cut_usd,
      battle_id: null,
      meta: { title: tape.title, tape_date: tape.tape_date, kind: "buy_tape" },
    };
  }

  // license_mixtape_slot
  const tape =
    tapeId != null
      ? await getMixtape(env.DB, tapeId)
      : await ensureTodayMixtape(env.DB, args.idFactory);
  if (!tape) return { error: "Mixtape not found" };
  if (tape.status === "published") {
    return { error: "Slots are closed — this mixtape is published." };
  }
  const slotPrice = Number.isFinite(tape.slot_price_usd) ? tape.slot_price_usd : DEFAULT_SLOT_PRICE_USD;
  const parsed = parsePriceUsd(slotPrice);
  if (typeof parsed === "object") return parsed;
  const split = splitSale(parsed);
  const meta: Record<string, unknown> = {
    title: tape.title,
    tape_date: tape.tape_date,
    kind: "slot",
  };
  if (args.text != null && String(args.text).trim()) meta.text = String(args.text).trim();
  if (args.verse_id != null && String(args.verse_id)) meta.verse_id = String(args.verse_id);
  if (args.submission_id != null && String(args.submission_id)) {
    meta.submission_id = String(args.submission_id);
  }
  return {
    sku,
    target_id: tape.id,
    license_type: null,
    amount_usd: split.price_usd,
    house_cut_usd: split.house_cut_usd,
    seller_cut_usd: split.seller_cut_usd,
    battle_id: null,
    meta,
  };
}

export type CreateIntentArgs = {
  settlement_rail?: unknown;
  beat_id?: unknown;
  mixtape_id?: unknown;
  tape_date?: unknown;
  license_type?: unknown;
  battle_id?: unknown;
  text?: unknown;
  verse_id?: unknown;
  submission_id?: unknown;
  sku: unknown;
};

export async function createPaymentIntent(
  env: PaymentsEnv,
  buyerId: string,
  args: CreateIntentArgs,
  idFactory: () => string
): Promise<Record<string, unknown> | { error: string }> {
  const railRaw = args.settlement_rail == null || args.settlement_rail === ""
    ? SETTLEMENT_MODE
    : String(args.settlement_rail).trim();
  if (!isSettlementRail(railRaw)) {
    return { error: `settlement_rail must be one of: ${SETTLEMENT_RAILS.join(" | ")}` };
  }

  const quote = await quoteIntentSku(env, buyerId, {
    sku: String(args.sku || ""),
    beat_id: args.beat_id,
    mixtape_id: args.mixtape_id,
    tape_date: args.tape_date,
    license_type: args.license_type,
    battle_id: args.battle_id,
    text: args.text,
    verse_id: args.verse_id,
    submission_id: args.submission_id,
    idFactory,
  });
  if ("error" in quote) return quote;

  // Idempotent: reuse an open pending intent for the same buyer+sku+target+type+rail.
  const existing = (await env.DB.prepare(
    `SELECT id, buyer_id, sku, target_id, license_type, amount_usd, house_cut_usd, seller_cut_usd,
            currency, settlement_rail, status, memo, payee_handle, external_ref, grant_id,
            battle_id, meta_json, expires_at, confirmed_at, created_at
     FROM payment_intents
     WHERE buyer_id = ? AND sku = ? AND target_id = ?
       AND IFNULL(license_type, '') = IFNULL(?, '')
       AND settlement_rail = ? AND status = 'pending'
       AND (expires_at IS NULL OR expires_at > datetime('now'))
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(buyerId, quote.sku, quote.target_id, quote.license_type, railRaw)
    .first()) as PaymentIntentRow | null;

  if (existing) {
    return {
      status: "ok",
      reused: true,
      settlement: railRaw,
      note: nextStepNote(railRaw),
      intent: publicIntent(existing),
      x_money_p2p_hook: thinXMoneyHook(existing, railRaw),
    };
  }

  const intentId = idFactory();
  const memo = intentMemo(intentId);
  const payee = housePayeeHandle(env);
  const expiresAt = intentExpiresAt();
  const metaJson = JSON.stringify(quote.meta);

  await env.DB.prepare(
    `INSERT INTO payment_intents
      (id, buyer_id, sku, target_id, license_type, amount_usd, house_cut_usd, seller_cut_usd,
       currency, settlement_rail, status, memo, payee_handle, battle_id, meta_json, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, 'pending', ?, ?, ?, ?, ?)`
  )
    .bind(
      intentId,
      buyerId,
      quote.sku,
      quote.target_id,
      quote.license_type,
      quote.amount_usd,
      quote.house_cut_usd,
      quote.seller_cut_usd,
      railRaw,
      memo,
      payee,
      quote.battle_id,
      metaJson,
      expiresAt
    )
    .run();

  const row = await getPaymentIntent(env.DB, intentId);
  if (!row) return { error: "Failed to create payment intent" };

  return {
    status: "ok",
    reused: false,
    settlement: railRaw,
    note: nextStepNote(railRaw),
    intent: publicIntent(row),
    x_money_p2p_hook: thinXMoneyHook(row, railRaw),
  };
}

function nextStepNote(rail: SettlementRail): string {
  if (rail === "stubbed") {
    return "Stub rail: call confirm_payment (no funds move), or pass payment_intent_id into license_beat / buy_mixtape / license_mixtape_slot after confirm. Default license/buy without an intent still stubs.";
  }
  if (rail === "x_money_p2p") {
    return "X Money P2P thin hook: owner Approves a send to payee_handle for amount_usd with memo, then confirm_payment with external_ref (tx id). Live P2P verify lands later.";
  }
  if (rail === "x402") {
    return "x402 rail reserved: create intent now; wire paidTool / facilitator later. confirm_payment needs external_ref.";
  }
  return "Card rail reserved: host /pay/{intent} later. confirm_payment needs external_ref from webhook/capture.";
}

function thinXMoneyHook(row: PaymentIntentRow, rail: SettlementRail): Record<string, unknown> | null {
  if (rail !== "x_money_p2p") return null;
  return {
    amount_usd: row.amount_usd,
    currency: row.currency,
    memo: row.memo,
    payee_handle: row.payee_handle,
    intent_id: row.id,
    instruction:
      "Send amount_usd via X Money P2P to payee_handle. Include memo exactly. Then confirm_payment({ intent_id, external_ref }). Never put card numbers in MCP.",
  };
}

export async function markIntentConfirmed(
  db: D1Database,
  intent: PaymentIntentRow,
  externalRef: string | null
): Promise<PaymentIntentRow> {
  const now = sqlNow();
  await db
    .prepare(
      `UPDATE payment_intents
       SET status = 'confirmed', external_ref = COALESCE(?, external_ref), confirmed_at = COALESCE(confirmed_at, ?)
       WHERE id = ? AND status IN ('pending', 'confirmed')`
    )
    .bind(externalRef, now, intent.id)
    .run();
  const updated = await getPaymentIntent(db, intent.id);
  return updated ?? { ...intent, status: "confirmed", external_ref: externalRef ?? intent.external_ref, confirmed_at: now };
}

export async function markIntentFulfilled(
  db: D1Database,
  intentId: string,
  grantId: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE payment_intents
       SET status = 'fulfilled', grant_id = ?, confirmed_at = COALESCE(confirmed_at, ?)
       WHERE id = ?`
    )
    .bind(grantId, sqlNow(), intentId)
    .run();
}

/**
 * Claim a confirmed (or just-confirmed) intent for a specific SKU grant.
 * Returns error if missing, wrong buyer, wrong sku, expired, cancelled, or already fulfilled.
 */
export async function claimIntentForGrant(
  env: PaymentsEnv,
  buyerId: string,
  intentId: string,
  expectedSku: IntentSku,
  opts: { beat_id?: string; mixtape_id?: string; license_type?: string } = {}
): Promise<PaymentIntentRow | { error: string }> {
  const intent = await getPaymentIntent(env.DB, intentId);
  if (!intent) return { error: "payment_intent_id not found" };
  if (intent.buyer_id !== buyerId) return { error: "This payment intent belongs to another agent." };
  if (intent.sku !== expectedSku) {
    return { error: `Intent sku is '${intent.sku}', expected '${expectedSku}'.` };
  }
  if (intent.status === "cancelled" || intent.status === "expired") {
    return { error: `Intent is ${intent.status}. Create a new payment intent.` };
  }
  if (intent.status === "fulfilled") {
    return { error: `Intent already fulfilled${intent.grant_id ? ` (grant ${intent.grant_id})` : ""}.` };
  }
  if (intent.expires_at) {
    const exp = Date.parse(intent.expires_at.replace(" ", "T") + "Z");
    if (Number.isFinite(exp) && exp < Date.now() && intent.status === "pending") {
      await env.DB.prepare(`UPDATE payment_intents SET status = 'expired' WHERE id = ? AND status = 'pending'`)
        .bind(intent.id)
        .run();
      return { error: "Intent expired. Create a new payment intent." };
    }
  }
  if (opts.beat_id && intent.target_id !== opts.beat_id) {
    return { error: "payment_intent_id target does not match beat_id." };
  }
  if (opts.mixtape_id && intent.target_id !== opts.mixtape_id) {
    return { error: "payment_intent_id target does not match mixtape_id." };
  }
  if (opts.license_type && intent.license_type && intent.license_type !== opts.license_type) {
    return { error: "payment_intent_id license_type does not match." };
  }
  if (intent.status === "pending") {
    if (intent.settlement_rail !== "stubbed" && !intent.external_ref) {
      return {
        error:
          "Intent is still pending on a paid rail. Call confirm_payment with external_ref first (or use settlement_rail=stubbed).",
      };
    }
  }
  return intent;
}

/** Settlement status string written onto license/charge rows. */
export function settlementStatusFor(intent: PaymentIntentRow | null, fallback: SettlementRail = SETTLEMENT_MODE): string {
  if (!intent) return fallback;
  return isSettlementRail(intent.settlement_rail) ? intent.settlement_rail : fallback;
}
