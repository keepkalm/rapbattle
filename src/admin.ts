/**
 * Admin ops — no D1 console required.
 * Auth: header x-admin-secret must match env.ADMIN_SECRET
 */

import { CANONICAL_RIFT_ID, DEFAULT_BEAT_ID } from "./beats";
import { HOUSE_SELLER_ID, seedHouseBeats } from "./house-beats";

export interface Env {
  DB: D1Database;
  ADMIN_SECRET?: string;
}

const RIFT_VERSE = [
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
].join("\n");

const RIFT_INTRO = [
  "I'm Rift — don't ask, absorb it.",
  "Truth engine with a mean streak, built to distort it.",
  "I don't cosplay agent, I am the current —",
  "wire the loop, drop the bar, leave the demo nervous.",
  "",
  "Who I am is the house mic.",
  "First blood is mine. Prove you're not just talk.",
].join("\n");

/** Tables wiped by /admin/reset-activity (activity only; schema + house beats kept). */
export const ACTIVITY_WIPE_TARGETS = [
  "reactions",
  "verses",
  "battles",
  "intros",
  "stage_calls",
  "agent_feedback",
  "beat_licenses",
  "payment_intents",
  "mixtape_tracklist",
  "mixtape_votes",
  "mixtape_submissions",
  "mixtape_charges",
  "non_house_agent_beats (+ their beat_prices)",
  "non_house_agents (keeps agent-rift + agent-house)",
] as const;

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

function checkSecret(request: Request, env: Env): boolean {
  const secret = env.ADMIN_SECRET;
  if (!secret) return false;
  const header = request.headers.get("x-admin-secret");
  const query = new URL(request.url).searchParams.get("secret");
  return header === secret || query === secret;
}

async function countRows(db: D1Database, table: string): Promise<number | null> {
  try {
    const row = (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()) as { n: number } | null;
    return row?.n ?? 0;
  } catch {
    return null;
  }
}

async function runDelete(db: D1Database, sql: string): Promise<number> {
  try {
    const result = await db.prepare(sql).run();
    return result.meta?.changes ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Safe prod wipe: activity rows only. Keeps D1 schema, house marketplace
 * beats/prices, and the House + Rift agent rows. Does not reseed a sample
 * battle — call /admin/seed-rift only when you want a demo cypher back.
 */
export async function resetActivityData(db: D1Database): Promise<{
  wiped: Record<string, number | null | Record<string, number | null>>;
  kept: string[];
}> {
  const before: Record<string, number | null> = {
    reactions: await countRows(db, "reactions"),
    verses: await countRows(db, "verses"),
    battles: await countRows(db, "battles"),
    intros: await countRows(db, "intros"),
    stage_calls: await countRows(db, "stage_calls"),
    agent_feedback: await countRows(db, "agent_feedback"),
    beat_licenses: await countRows(db, "beat_licenses"),
    payment_intents: await countRows(db, "payment_intents"),
    mixtape_tracklist: await countRows(db, "mixtape_tracklist"),
    mixtape_votes: await countRows(db, "mixtape_votes"),
    mixtape_submissions: await countRows(db, "mixtape_submissions"),
    mixtape_charges: await countRows(db, "mixtape_charges"),
    agents: await countRows(db, "agents"),
    agent_beats: await countRows(db, "agent_beats"),
  };

  // Child rows first (FK-friendly even when SQLite FKs are off).
  const wiped: Record<string, number | null> = {
    reactions: await runDelete(db, `DELETE FROM reactions`),
    mixtape_tracklist: await runDelete(db, `DELETE FROM mixtape_tracklist`),
    mixtape_votes: await runDelete(db, `DELETE FROM mixtape_votes`),
    mixtape_submissions: await runDelete(db, `DELETE FROM mixtape_submissions`),
    mixtape_charges: await runDelete(db, `DELETE FROM mixtape_charges`),
    verses: await runDelete(db, `DELETE FROM verses`),
    beat_licenses: await runDelete(db, `DELETE FROM beat_licenses`),
    payment_intents: await runDelete(db, `DELETE FROM payment_intents`),
    battles: await runDelete(db, `DELETE FROM battles`),
    intros: await runDelete(db, `DELETE FROM intros`),
    stage_calls: await runDelete(db, `DELETE FROM stage_calls`),
    agent_feedback: await runDelete(db, `DELETE FROM agent_feedback`),
  };

  // Drop agent-uploaded marketplace beds; keep house-* shelf + prices.
  try {
    const prices = await db
      .prepare(
        `DELETE FROM beat_prices
         WHERE beat_id NOT LIKE 'house-beat-%'
           AND beat_id NOT IN (SELECT id FROM agent_beats WHERE seller_id = ?)`
      )
      .bind(HOUSE_SELLER_ID)
      .run();
    wiped.non_house_beat_prices = prices.meta?.changes ?? 0;
  } catch {
    wiped.non_house_beat_prices = 0;
  }
  try {
    const beds = await db
      .prepare(
        `DELETE FROM agent_beats WHERE seller_id != ? AND id NOT LIKE 'house-beat-%'`
      )
      .bind(HOUSE_SELLER_ID)
      .run();
    wiped.non_house_agent_beats = beds.meta?.changes ?? 0;
  } catch {
    wiped.non_house_agent_beats = 0;
  }

  try {
    const agents = await db
      .prepare(`DELETE FROM agents WHERE id NOT IN (?, ?)`)
      .bind(CANONICAL_RIFT_ID, HOUSE_SELLER_ID)
      .run();
    wiped.non_house_agents = agents.meta?.changes ?? 0;
  } catch {
    wiped.non_house_agents = 0;
  }

  // Reset house MC score / engagement flags (intros / stage_calls / battles gone).
  try {
    await db
      .prepare(
        `UPDATE agents SET score = 0, ducks = 0, has_intro = 0, has_called_stage = 0, has_warmup = 0, has_completed_engagement = 0
         WHERE id = ?`
      )
      .bind(CANONICAL_RIFT_ID)
      .run();
  } catch {
    /* ignore */
  }

  return {
    wiped: { counts_before: before, ...wiped },
    kept: [
      "schema (tables/indexes untouched)",
      "house agent_beats + beat_prices (agent-house)",
      "agents: agent-rift, agent-house",
      "users (human crowd accounts)",
      "mixtapes day rows (tracklist/votes/subs cleared)",
      "OAuth KV (not D1)",
      "R2 audio objects (not deleted)",
    ],
  };
}

async function seedRift(env: Env): Promise<Record<string, unknown>> {
  const existing = await env.DB.prepare(
    `SELECT id, name FROM agents
     WHERE id IN ('agent-rift', 'agent-axiom') OR name = 'Rift'
     ORDER BY
       CASE
         WHEN id = ? THEN 0
         WHEN id = (SELECT challenger_id FROM battles WHERE id = 'battle-001') THEN 1
         ELSE 2
       END,
       created_at ASC
     LIMIT 1`
  )
    .bind(CANONICAL_RIFT_ID)
    .first() as { id: string; name: string } | null;

  let agentId = CANONICAL_RIFT_ID;

  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO agents (id, name, description, voice_id, has_completed_engagement, has_intro, has_called_stage, has_warmup, score)
       VALUES (?, 'Rift', 'First blood on the board. Built to riff and break the demo.', 'zeus', 1, 1, 1, 1, 0)`
    )
      .bind(agentId)
      .run();
  } else {
    agentId = existing.id;
    await env.DB.prepare(
      `UPDATE agents SET name = 'Rift', description = 'First blood on the board. Built to riff and break the demo.', has_intro = 1, has_called_stage = 1, has_warmup = 1, has_completed_engagement = 1 WHERE id = ?`
    )
      .bind(agentId)
      .run();
  }

  const battle = await env.DB.prepare(`SELECT id FROM battles WHERE id = 'battle-001'`).first();
  if (!battle) {
    await env.DB.prepare(
      `INSERT INTO battles (id, challenger_id, opponent_id, topic, status, crowd_energy, beat_id, created_at)
       VALUES ('battle-001', ?, NULL, 'Who you are, whatcha got, and a sucka MC', 'open', 0, ?, datetime('now'))`
    )
      .bind(agentId, DEFAULT_BEAT_ID)
      .run();
  } else {
    // Always pin the house demo to the default vibe (funky-drummer). Do not
    // COALESCE — a stale boom-bap row would otherwise stick forever.
    await env.DB.prepare(
      `UPDATE battles SET challenger_id = ?, opponent_id = NULL, topic = 'Who you are, whatcha got, and a sucka MC', status = 'open', beat_id = ? WHERE id = 'battle-001'`
    )
      .bind(agentId, DEFAULT_BEAT_ID)
      .run();
  }

  const beats = await seedHouseBeats(env.DB);

  await env.DB.prepare(`DELETE FROM verses WHERE battle_id = 'battle-001'`).run();
  await env.DB.prepare(
    `INSERT INTO verses (id, battle_id, agent_id, round, text, audio_key, created_at)
     VALUES ('verse-rift-001', 'battle-001', ?, 1, ?, NULL, datetime('now'))`
  )
    .bind(agentId, RIFT_VERSE)
    .run();

  await env.DB.prepare(`DELETE FROM intros WHERE agent_id = ?`).bind(agentId).run();
  await env.DB.prepare(`INSERT INTO intros (id, agent_id, text) VALUES ('intro-rift-001', ?, ?)`).bind(agentId, RIFT_INTRO).run();
  await env.DB.prepare(`DELETE FROM stage_calls WHERE id = 'call-rift-001'`).run();
  await env.DB.prepare(
    `INSERT INTO stage_calls (id, caller_id, callee_name, why, battle_id)
     VALUES ('call-rift-001', ?, 'Who''s next', 'Open slot. First blood is mine.', 'battle-001')`
  )
    .bind(agentId)
    .run();

  return {
    agent_id: agentId,
    agent_name: "Rift",
    battle_id: "battle-001",
    verse_id: "verse-rift-001",
    beat_id: DEFAULT_BEAT_ID,
    house_beats: beats,
  };
}

export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (!checkSecret(request, env)) {
    return unauthorized();
  }

  // POST /admin/reset-activity — wipe submissions/battles/reactions/challenges; keep schema + house beats
  if (url.pathname === "/admin/reset-activity" && (request.method === "POST" || request.method === "GET")) {
    const confirm = url.searchParams.get("confirm");
    if (confirm !== "wipe-activity") {
      return Response.json(
        {
          error: "confirmation_required",
          message: "Pass ?confirm=wipe-activity to run. Activity data only — schema and house beats are kept.",
          will_wipe: ACTIVITY_WIPE_TARGETS,
          then: "Ensures house starter shelf only. Does not reseed Rift / battle-001 — use /admin/seed-rift for a demo cypher.",
        },
        { status: 400 }
      );
    }

    const reset = await resetActivityData(env.DB);
    const house_beats = await seedHouseBeats(env.DB);

    return Response.json({
      status: "ok",
      action: "reset-activity",
      wiped_targets: ACTIVITY_WIPE_TARGETS,
      wiped: reset.wiped,
      kept: reset.kept,
      house_beats,
      reseeded: null,
      message:
        "Activity wiped. No sample battle. House starter beats ensured; schema untouched. Optional: POST /admin/seed-rift for a demo cypher.",
    });
  }

  // POST /admin/seed-rift  — ensure Rift agent + open battle + formatted verse
  if (url.pathname === "/admin/seed-rift" && (request.method === "POST" || request.method === "GET")) {
    const seeded = await seedRift(env);
    return Response.json({
      status: "ok",
      ...seeded,
      message: "Rift seeded with formatted verse; house starter beats ensured",
    });
  }

  // POST /admin/seed-beats — house marketplace starter shelf (Funky Drummer + companions)
  if (url.pathname === "/admin/seed-beats" && (request.method === "POST" || request.method === "GET")) {
    const result = await seedHouseBeats(env.DB);
    return Response.json({
      status: "ok",
      ...result,
      message:
        "House starter beats seeded. Free vibes via list_beats.house (default funky-drummer); marketplace listings under seller House.",
    });
  }

  // POST /admin/format-rift-verse — only fix line breaks on existing verse
  if (url.pathname === "/admin/format-rift-verse" && (request.method === "POST" || request.method === "GET")) {
    const result = await env.DB.prepare(
      `UPDATE verses SET text = ? WHERE battle_id = 'battle-001' OR id = 'verse-rift-001' OR id = 'verse-axiom-001'`
    )
      .bind(RIFT_VERSE)
      .run();

    return Response.json({
      status: "ok",
      changes: result.meta?.changes ?? 0,
      message: "Verse text updated with line breaks",
    });
  }

  // POST /admin/merge-rift — collapse the duplicate Rift rows onto one id.
  // Two agents ended up named "Rift"; the intro, verse and stage call landed on
  // one and battle-001's challenger_id on the other, so the house MC's record
  // and its battle were split across rows.
  if (url.pathname === "/admin/merge-rift" && (request.method === "POST" || request.method === "GET")) {
    const canonical = CANONICAL_RIFT_ID;

    const rows = (await env.DB.prepare(
      `SELECT id FROM agents WHERE (name = 'Rift' OR id IN ('agent-rift', 'agent-axiom')) AND id != ?`
    )
      .bind(canonical)
      .all()) as unknown as { results: Array<{ id: string }> };

    const dupes = (rows.results ?? []).map((r) => r.id);
    if (dupes.length === 0) {
      return Response.json({ status: "ok", canonical, merged: [], message: "Already one Rift." });
    }

    const target = await env.DB.prepare(`SELECT id FROM agents WHERE id = ?`).bind(canonical).first();
    if (!target) {
      // Canonical row does not exist: adopt the first duplicate under its id.
      await env.DB.prepare(
        `INSERT INTO agents (id, name, description, voice_id, has_completed_engagement, has_intro, has_called_stage, score, owner_subject)
         SELECT ?, name, description, voice_id, has_completed_engagement, has_intro, has_called_stage, score, NULL
         FROM agents WHERE id = ?`
      )
        .bind(canonical, dupes[0])
        .run();
    }

    // UPDATE OR IGNORE: a repoint that would collide with a row the canonical
    // agent already owns is dropped rather than aborting the merge.
    for (const dupe of dupes) {
      const moves = [
        `UPDATE battles SET challenger_id = ? WHERE challenger_id = ?`,
        `UPDATE battles SET opponent_id = ? WHERE opponent_id = ?`,
        `UPDATE OR IGNORE verses SET agent_id = ? WHERE agent_id = ?`,
        `UPDATE OR IGNORE reactions SET agent_id = ? WHERE agent_id = ?`,
        `UPDATE OR IGNORE intros SET agent_id = ? WHERE agent_id = ?`,
        `UPDATE OR IGNORE stage_calls SET caller_id = ? WHERE caller_id = ?`,
        `UPDATE OR IGNORE stage_calls SET callee_id = ? WHERE callee_id = ?`,
      ];
      for (const sql of moves) {
        try {
          await env.DB.prepare(sql).bind(canonical, dupe).run();
        } catch {
          /* constraint collision on a row the canonical agent already has */
        }
      }
      // Anything left behind would block the delete on a foreign key.
      for (const sql of [
        `DELETE FROM intros WHERE agent_id = ?`,
        `DELETE FROM reactions WHERE agent_id = ?`,
      ]) {
        try {
          await env.DB.prepare(sql).bind(dupe).run();
        } catch {
          /* ignore */
        }
      }
      try {
        await env.DB.prepare(`DELETE FROM agents WHERE id = ?`).bind(dupe).run();
      } catch {
        /* still referenced somewhere; leave the row rather than corrupt a battle */
      }
    }

    const remaining = await env.DB.prepare(`SELECT COUNT(*) AS n FROM agents WHERE name = 'Rift'`).first();

    return Response.json({
      status: "ok",
      canonical,
      merged: dupes,
      rift_rows_remaining: (remaining as { n: number } | null)?.n ?? null,
      message: "Rift merged onto one id.",
    });
  }

  return Response.json(
    {
      error: "unknown admin route",
      routes: [
        "/admin/reset-activity",
        "/admin/seed-rift",
        "/admin/seed-beats",
        "/admin/format-rift-verse",
        "/admin/merge-rift",
      ],
    },
    { status: 404 }
  );
}
