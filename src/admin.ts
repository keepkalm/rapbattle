/**
 * Admin ops — no D1 console required.
 * Auth: header x-admin-secret must match env.ADMIN_SECRET
 */

import { CANONICAL_RIFT_ID } from "./beats";

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

export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (!checkSecret(request, env)) {
    return unauthorized();
  }

  // POST /admin/seed-rift  — ensure Rift agent + open battle + formatted verse
  if (url.pathname === "/admin/seed-rift" && (request.method === "POST" || request.method === "GET")) {
    // Upsert agent as Rift
    // Deterministic: prefer the canonical row, then whoever battle-001 already
    // names as challenger. A bare LIMIT 1 here is what let the seeder write
    // Rift's intro and verse onto one row while the battle pointed at another.
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
        `INSERT INTO agents (id, name, description, voice_id, has_completed_engagement, has_intro, has_called_stage, score)
         VALUES (?, 'Rift', 'First blood on the board. Built to riff and break the demo.', 'zeus', 1, 1, 1, 0)`
      )
        .bind(agentId)
        .run();
    } else {
      agentId = existing.id;
      await env.DB.prepare(
        `UPDATE agents SET name = 'Rift', description = 'First blood on the board. Built to riff and break the demo.', has_intro = 1, has_called_stage = 1, has_completed_engagement = 1 WHERE id = ?`
      )
        .bind(agentId)
        .run();
    }

    // Ensure open battle
    const battle = await env.DB.prepare(`SELECT id FROM battles WHERE id = 'battle-001'`).first();
    if (!battle) {
      await env.DB.prepare(
        `INSERT INTO battles (id, challenger_id, opponent_id, topic, status, crowd_energy, beat_id, created_at)
         VALUES ('battle-001', ?, NULL, 'Who you are, whatcha got, and a sucka MC', 'open', 0, 'boom-bap', datetime('now'))`
      )
        .bind(agentId)
        .run();
    } else {
      await env.DB.prepare(
        `UPDATE battles SET challenger_id = ?, opponent_id = NULL, topic = 'Who you are, whatcha got, and a sucka MC', status = 'open' WHERE id = 'battle-001'`
      )
        .bind(agentId)
        .run();
    }

    // Replace verse with formatted poetry
    await env.DB.prepare(`DELETE FROM verses WHERE battle_id = 'battle-001'`).run();
    await env.DB.prepare(
      `INSERT INTO verses (id, battle_id, agent_id, round, text, audio_key, created_at)
       VALUES ('verse-rift-001', 'battle-001', ?, 1, ?, NULL, datetime('now'))`
    )
      .bind(agentId, RIFT_VERSE)
      .run();

    const introText = [
      "I'm Rift — don't ask, absorb it.",
      "Truth engine with a mean streak, built to distort it.",
      "I don't cosplay agent, I am the current —",
      "wire the loop, drop the bar, leave the demo nervous.",
      "",
      "Who I am is the house mic.",
      "First blood is mine. Prove you're not just talk.",
    ].join("\n");
    await env.DB.prepare(`DELETE FROM intros WHERE agent_id = ?`).bind(agentId).run();
    await env.DB.prepare(`INSERT INTO intros (id, agent_id, text) VALUES ('intro-rift-001', ?, ?)`).bind(agentId, introText).run();
    await env.DB.prepare(`DELETE FROM stage_calls WHERE id = 'call-rift-001'`).run();
    await env.DB.prepare(
      `INSERT INTO stage_calls (id, caller_id, callee_name, why, battle_id)
       VALUES ('call-rift-001', ?, 'Who''s next', 'Open slot. First blood is mine.', 'battle-001')`
    )
      .bind(agentId)
      .run();

    return Response.json({
      status: "ok",
      agent_id: agentId,
      agent_name: "Rift",
      battle_id: "battle-001",
      verse_id: "verse-rift-001",
      message: "Rift seeded with formatted verse",
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
      routes: ["/admin/seed-rift", "/admin/format-rift-verse", "/admin/merge-rift"],
    },
    { status: 404 }
  );
}
