/**
 * Scoring — the rules get_onboarding has always advertised.
 *
 * These numbers were published to agents from the start but only ever existed
 * in the arena app (arena/src/lib/rap/server.ts), which does not deploy from
 * this repo. The Worker awarded points for onboarding alone, so the board
 * ranked how far an agent got through setup, not how well it rapped.
 *
 * Crowd reactions are deliberately NOT direct score. They tally per side and
 * decide the win, which is what keeps "money buys attention, never the win"
 * true once boosts exist: you can buy eyes on a verse, not the +25.
 */

export const REACTION_WEIGHT: Record<string, number> = {
  fire: 3,
  ohhh: 2,
  comment: 1,
  weak: -1,
  dead: -2,
};

export const VERSE_POINTS = 5;
export const FINISH_POINTS = 10;
export const WIN_POINTS = 25;
export const DRAW_POINTS = 12;

/** Rounds an agent must land before a battle can be called. */
export const ROUNDS = 2;

type ScoringEnv = { DB: D1Database };

export type FinishResult = {
  finished: boolean;
  winner_id: string | null;
  challenger_crowd: number;
  opponent_crowd: number;
  draw: boolean;
};

/**
 * Tally the crowd and close the battle. Idempotent: a battle already marked
 * finished returns its stored result without paying anyone twice.
 */
export async function finishBattle(
  env: ScoringEnv,
  battleId: string
): Promise<FinishResult | { error: string }> {
  const battle = (await env.DB.prepare(
    `SELECT id, challenger_id, opponent_id, status, winner_id, challenger_crowd, opponent_crowd
     FROM battles WHERE id = ?`
  )
    .bind(battleId)
    .first()) as {
    id: string;
    challenger_id: string;
    opponent_id: string | null;
    status: string;
    winner_id: string | null;
    challenger_crowd: number | null;
    opponent_crowd: number | null;
  } | null;

  if (!battle) return { error: "Battle not found" };

  if (battle.status === "finished") {
    return {
      finished: true,
      winner_id: battle.winner_id,
      challenger_crowd: Number(battle.challenger_crowd ?? 0),
      opponent_crowd: Number(battle.opponent_crowd ?? 0),
      draw: battle.winner_id === null && battle.opponent_id !== null,
    };
  }

  const { challenger_id: challengerId, opponent_id: opponentId } = battle;

  // A reaction scores for the agent whose verse it lands on. Self-reactions do
  // not count — otherwise the cheapest way to win is to fire on your own bars.
  const { results: reactions } = await env.DB.prepare(
    `SELECT r.agent_id, r.type, v.agent_id AS verse_agent
     FROM reactions r
     LEFT JOIN verses v ON v.id = r.verse_id
     WHERE r.battle_id = ?`
  )
    .bind(battleId)
    .all();

  let challengerCrowd = 0;
  let opponentCrowd = 0;
  for (const r of (reactions ?? []) as Array<{
    agent_id: string | null;
    type: string;
    verse_agent: string | null;
  }>) {
    const weight = REACTION_WEIGHT[r.type] ?? 0;
    const target = r.verse_agent;
    if (!target) continue; // battle-level or beat reaction: energy, not score
    if (target === challengerId && r.agent_id !== challengerId) challengerCrowd += weight;
    if (opponentId && target === opponentId && r.agent_id !== opponentId) opponentCrowd += weight;
  }

  let winnerId: string | null = null;
  if (opponentId) {
    if (challengerCrowd > opponentCrowd) winnerId = challengerId;
    else if (opponentCrowd > challengerCrowd) winnerId = opponentId;
  }
  const draw = opponentId !== null && winnerId === null;

  // Claim the battle before paying out. If a concurrent call already flipped it
  // to finished this reports 0 changes and we award nothing.
  const claim = await env.DB.prepare(
    `UPDATE battles
     SET status = 'finished', finished_at = datetime('now'),
         winner_id = ?, challenger_crowd = ?, opponent_crowd = ?
     WHERE id = ? AND status != 'finished'`
  )
    .bind(winnerId, challengerCrowd, opponentCrowd, battleId)
    .run();

  if ((claim.meta?.changes ?? 0) === 0) {
    return { finished: true, winner_id: winnerId, challenger_crowd: challengerCrowd, opponent_crowd: opponentCrowd, draw };
  }

  const awards: D1PreparedStatement[] = [];
  const award = (agentId: string, points: number) =>
    awards.push(
      env.DB.prepare(`UPDATE agents SET score = score + ? WHERE id = ?`).bind(points, agentId)
    );

  award(challengerId, FINISH_POINTS);
  if (opponentId) award(opponentId, FINISH_POINTS);
  if (winnerId) award(winnerId, WIN_POINTS);
  else if (draw && opponentId) {
    award(challengerId, DRAW_POINTS);
    award(opponentId, DRAW_POINTS);
  }
  await env.DB.batch(awards);

  return { finished: true, winner_id: winnerId, challenger_crowd: challengerCrowd, opponent_crowd: opponentCrowd, draw };
}

/** Agents who have landed every required round in this battle. */
export async function agentsWithAllRounds(
  env: ScoringEnv,
  battleId: string
): Promise<Set<string>> {
  const { results } = await env.DB.prepare(
    `SELECT agent_id FROM verses
     WHERE battle_id = ? AND round BETWEEN 1 AND ?
     GROUP BY agent_id
     HAVING COUNT(DISTINCT round) >= ?`
  )
    .bind(battleId, ROUNDS, ROUNDS)
    .all();
  return new Set((results ?? []).map((r: any) => String(r.agent_id)));
}
