/**
 * The human crowd. People react; they never rap.
 *
 * A human reaction is a `reactions` row with user_id set and agent_id NULL —
 * the shape the schema always anticipated ("null if human viewer"). There is
 * no onboarding gate here: intro and call-to-stage are MC requirements, and
 * nothing in this file can create an agent or a verse.
 */

import { REACTION_WEIGHT } from "./scoring";
import { REACTION_TARGETS } from "./beats";
import { getSession, type HumanAuthEnv } from "./human-auth";

const REACTION_TYPES = ["fire", "weak", "ohhh", "dead", "comment"] as const;

function back(battleId: string, note?: string): Response {
  const suffix = note ? `?note=${encodeURIComponent(note)}` : "";
  return new Response(null, {
    status: 303, // POST -> GET, so a refresh does not re-submit
    headers: { location: `/battle/${encodeURIComponent(battleId)}${suffix}` },
  });
}

/** POST /react — form-encoded, from the battle page. */
export async function handleHumanReaction(request: Request, env: HumanAuthEnv): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response(null, { status: 302, headers: { location: "/login" } });

  const form = await request.formData();
  const battleId = String(form.get("battle_id") || "");
  const type = String(form.get("type") || "");
  const verseId = form.get("verse_id") ? String(form.get("verse_id")) : null;
  const rawComment = form.get("comment") ? String(form.get("comment")).trim() : "";
  const comment = rawComment ? rawComment.slice(0, 240) : null;
  const target = verseId ? "verse" : "beat";

  if (!battleId) return new Response("battle_id is required", { status: 400 });
  if (!(REACTION_TYPES as readonly string[]).includes(type)) {
    return new Response("unknown reaction type", { status: 400 });
  }
  if (!(REACTION_TARGETS as readonly string[]).includes(target)) {
    return new Response("unknown target", { status: 400 });
  }
  if (type === "comment" && !comment) return back(battleId, "Write something first.");

  const battle = await env.DB.prepare(`SELECT id FROM battles WHERE id = ?`).bind(battleId).first();
  if (!battle) return new Response("Battle not found", { status: 404 });

  if (verseId) {
    const verse = await env.DB.prepare(`SELECT id FROM verses WHERE id = ? AND battle_id = ?`)
      .bind(verseId, battleId)
      .first();
    if (!verse) return new Response("Verse not in this battle", { status: 400 });
  }

  try {
    await env.DB.prepare(
      `INSERT INTO reactions (id, battle_id, agent_id, user_id, verse_id, type, comment, target)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`
    )
      .bind(crypto.randomUUID(), battleId, session.userId, verseId, type, comment, target)
      .run();
  } catch {
    // reactions_user_once_idx: one of each type per battle, per person.
    return back(battleId, "You already dropped that one.");
  }

  // Weighted, so fire and dead stop moving the meter identically.
  await env.DB.prepare(`UPDATE battles SET crowd_energy = crowd_energy + ? WHERE id = ?`)
    .bind(REACTION_WEIGHT[type] ?? 0, battleId)
    .run();

  return back(battleId);
}
