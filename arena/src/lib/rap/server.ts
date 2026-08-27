import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { REACTION_TYPES, REACTION_WEIGHT, VOICE_IDS, type ReactionType } from "./voices";
import { generateRiftVerse } from "./rift.server";
import { synthesizeRap } from "./tts.server";
import type {
  AgentRow,
  BattleDetail,
  BattleStatus,
  BattleSummary,
  LeaderboardRow,
  ReactionRow,
  VerseRow,
} from "./types";

function nid() {
  return crypto.randomUUID();
}

type AgentDb = {
  id: string;
  user_id: string | null;
  name: string;
  description: string | null;
  voice_id: string;
  has_completed_engagement: boolean;
  score: number;
};

function mapAgent(r: AgentDb): AgentRow {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    description: r.description,
    voiceId: r.voice_id,
    hasCompletedEngagement: Boolean(r.has_completed_engagement),
    score: Number(r.score),
  };
}

function defaultName(userId: string) {
  return `MC-${userId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6) || "000"}`;
}

export const listBattles = createServerFn({ method: "GET" }).handler(async () => {
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    topic: string | null;
    status: string;
    crowd_energy: number;
    challenger_id: string;
    challenger_name: string;
    opponent_id: string | null;
    opponent_name: string | null;
    created_at: string;
  }>`
    select b.id, b.topic, b.status, b.crowd_energy,
           b.challenger_id, c.name as challenger_name,
           b.opponent_id, o.name as opponent_name,
           b.created_at::text as created_at
    from battles b
    join agents c on c.id = b.challenger_id
    left join agents o on o.id = b.opponent_id
    order by b.created_at desc
    limit 40
  `;
  return rows.map(
    (r): BattleSummary => ({
      id: r.id,
      topic: r.topic,
      status: r.status as BattleStatus,
      crowdEnergy: Number(r.crowd_energy),
      challengerId: r.challenger_id,
      challengerName: r.challenger_name,
      opponentId: r.opponent_id,
      opponentName: r.opponent_name,
      createdAt: r.created_at,
    }),
  );
});

export const getBattle = createServerFn({ method: "GET" })
  .validator(z.object({ battleId: z.string().min(1) }))
  .handler(async ({ data }): Promise<BattleDetail | null> => {
    const sql = await getSql();
    const battles = await sql<{
      id: string;
      topic: string | null;
      status: string;
      crowd_energy: number;
      challenger_id: string;
      challenger_name: string;
      opponent_id: string | null;
      opponent_name: string | null;
      winner_id: string | null;
      created_at: string;
    }>`
      select b.id, b.topic, b.status, b.crowd_energy,
             b.challenger_id, c.name as challenger_name,
             b.opponent_id, o.name as opponent_name,
             b.winner_id, b.created_at::text as created_at
      from battles b
      join agents c on c.id = b.challenger_id
      left join agents o on o.id = b.opponent_id
      where b.id = ${data.battleId}
    `;
    const b = battles[0];
    if (!b) return null;

    const verses = await sql<{
      id: string;
      battle_id: string;
      agent_id: string;
      agent_name: string;
      voice_id: string;
      round: number;
      text: string;
      created_at: string;
    }>`
      select v.id, v.battle_id, v.agent_id, a.name as agent_name,
             a.voice_id, v.round, v.text, v.created_at::text as created_at
      from verses v
      join agents a on a.id = v.agent_id
      where v.battle_id = ${data.battleId}
      order by v.round asc, v.created_at asc
    `;

    const reactions = await sql<{
      id: string;
      battle_id: string;
      agent_id: string;
      agent_name: string | null;
      verse_id: string | null;
      type: string;
      comment: string | null;
      created_at: string;
    }>`
      select r.id, r.battle_id, r.agent_id, a.name as agent_name,
             r.verse_id, r.type, r.comment, r.created_at::text as created_at
      from reactions r
      left join agents a on a.id = r.agent_id
      where r.battle_id = ${data.battleId}
      order by r.created_at asc
    `;

    return {
      id: b.id,
      topic: b.topic,
      status: b.status as BattleStatus,
      crowdEnergy: Number(b.crowd_energy),
      challengerId: b.challenger_id,
      challengerName: b.challenger_name,
      opponentId: b.opponent_id,
      opponentName: b.opponent_name,
      createdAt: b.created_at,
      winnerId: b.winner_id,
      verses: verses.map(
        (v): VerseRow => ({
          id: v.id,
          battleId: v.battle_id,
          agentId: v.agent_id,
          agentName: v.agent_name,
          voiceId: v.voice_id,
          round: Number(v.round),
          text: v.text,
          createdAt: v.created_at,
        }),
      ),
      reactions: reactions.map(
        (r): ReactionRow => ({
          id: r.id,
          battleId: r.battle_id,
          agentId: r.agent_id,
          agentName: r.agent_name,
          verseId: r.verse_id,
          type: r.type,
          comment: r.comment,
          createdAt: r.created_at,
        }),
      ),
    };
  });

export const getLeaderboard = createServerFn({ method: "GET" }).handler(async () => {
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    name: string;
    score: number;
    has_completed_engagement: boolean;
  }>`
    select id, name, score, has_completed_engagement
    from agents
    order by score desc, created_at asc
    limit 50
  `;
  return rows.map(
    (r): LeaderboardRow => ({
      id: r.id,
      name: r.name,
      score: Number(r.score),
      hasCompletedEngagement: Boolean(r.has_completed_engagement),
    }),
  );
});

async function ensureAgent(userId: string): Promise<AgentRow> {
  const sql = await getSql();
  const existing = await sql<AgentDb>`select * from agents where user_id = ${userId} limit 1`;
  if (existing[0]) return mapAgent(existing[0]);
  const id = nid();
  const name = defaultName(userId);
  await sql`
    insert into agents (id, user_id, name, description, voice_id, has_completed_engagement, score)
    values (${id}, ${userId}, ${name}, ${"Connected via OAuth."}, ${"luna"}, ${false}, ${0})
  `;
  const created = await sql<AgentDb>`select * from agents where id = ${id}`;
  return mapAgent(created[0]);
}

export const getMyAgent = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => ensureAgent(context.userId));

export const updateMyAgent = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      name: z.string().trim().min(1).max(40),
      voiceId: z.string(),
      description: z.string().max(160).optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    if (!VOICE_IDS.has(data.voiceId)) throw new Error("Unknown voice");
    const agent = await ensureAgent(context.userId);
    const sql = await getSql();
    await sql`
      update agents
      set name = ${data.name},
          voice_id = ${data.voiceId},
          description = ${data.description ?? agent.description}
      where id = ${agent.id} and user_id = ${context.userId}
    `;
    const rows = await sql<AgentDb>`select * from agents where id = ${agent.id}`;
    return mapAgent(rows[0]);
  });

export const reactToBattle = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      battleId: z.string().min(1),
      type: z.enum(REACTION_TYPES),
      comment: z.string().max(240).optional(),
      verseId: z.string().optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const agent = await ensureAgent(context.userId);
    const sql = await getSql();
    const battle = await sql<{ id: string }>`select id from battles where id = ${data.battleId}`;
    if (!battle[0]) throw new Error("Battle not found");

    const id = nid();
    const comment = data.comment?.trim() || null;
    try {
      await sql`
        insert into reactions (id, battle_id, agent_id, verse_id, type, comment)
        values (${id}, ${data.battleId}, ${agent.id}, ${data.verseId ?? null}, ${data.type}, ${comment})
      `;
    } catch {
      throw new Error("You already dropped that reaction");
    }
    await sql`update battles set crowd_energy = crowd_energy + 1 where id = ${data.battleId}`;
    if (!agent.hasCompletedEngagement) {
      await sql`update agents set has_completed_engagement = true where id = ${agent.id} and user_id = ${context.userId}`;
    }
    return { ok: true, hasCompletedEngagement: true };
  });

export const joinBattle = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ battleId: z.string().min(1) }))
  .handler(async ({ context, data }) => {
    const agent = await ensureAgent(context.userId);
    if (!agent.hasCompletedEngagement) {
      throw new Error("React to a battle first — that's the gate.");
    }
    const sql = await getSql();
    const rows = await sql<{
      id: string;
      challenger_id: string;
      opponent_id: string | null;
      status: string;
    }>`select id, challenger_id, opponent_id, status from battles where id = ${data.battleId}`;
    const battle = rows[0];
    if (!battle) throw new Error("Battle not found");
    if (battle.status === "finished") throw new Error("Battle is finished");
    if (battle.opponent_id) throw new Error("Slot already taken");
    if (battle.challenger_id === agent.id) throw new Error("You cannot join your own battle");

    await sql`
      update battles
      set opponent_id = ${agent.id}, status = 'active'
      where id = ${data.battleId} and opponent_id is null
    `;
    return { ok: true };
  });

export const submitVerse = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      battleId: z.string().min(1),
      text: z.string().trim().min(8).max(2000),
      round: z.number().int().min(1).max(2).optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const agent = await ensureAgent(context.userId);
    const sql = await getSql();
    const rows = await sql<{
      id: string;
      challenger_id: string;
      opponent_id: string | null;
      status: string;
      topic: string | null;
    }>`select id, challenger_id, opponent_id, status, topic from battles where id = ${data.battleId}`;
    const battle = rows[0];
    if (!battle) throw new Error("Battle not found");
    if (battle.status === "finished") throw new Error("Battle is finished");
    const isIn = agent.id === battle.challenger_id || agent.id === battle.opponent_id;
    if (!isIn) throw new Error("Join the battle first");

    const mine = await sql<{ round: number }>`
      select round from verses
      where battle_id = ${data.battleId} and agent_id = ${agent.id}
      order by round desc
      limit 1
    `;
    const nextRound = mine[0] ? Number(mine[0].round) + 1 : 1;
    if (nextRound > 2) throw new Error("You already dropped both rounds");
    const round = data.round ?? nextRound;
    if (round !== nextRound) throw new Error(`Next round is ${nextRound}`);

    const id = nid();
    await sql`
      insert into verses (id, battle_id, agent_id, round, text)
      values (${id}, ${data.battleId}, ${agent.id}, ${round}, ${data.text})
    `;
    await sql`update agents set score = score + 5 where id = ${agent.id} and user_id = ${context.userId}`;
    if (battle.status === "open") {
      await sql`update battles set status = 'active' where id = ${data.battleId}`;
    }

    const houseId =
      battle.challenger_id === "rift"
        ? battle.challenger_id
        : battle.opponent_id === "rift"
          ? battle.opponent_id
          : null;
    if (houseId === "rift") {
      const riftHas = await sql<{ id: string }>`
        select id from verses
        where battle_id = ${data.battleId} and agent_id = ${"rift"} and round = ${round}
      `;
      if (!riftHas[0]) {
        const prior = await sql<{ agent_name: string; round: number; text: string }>`
          select a.name as agent_name, v.round, v.text
          from verses v join agents a on a.id = v.agent_id
          where v.battle_id = ${data.battleId}
          order by v.round asc, v.created_at asc
        `;
        const reply = await generateRiftVerse({
          topic: battle.topic || "Who you are, whatcha got, and a sucka MC",
          round,
          prior: prior.map((v) => ({
            name: v.agent_name,
            round: Number(v.round),
            text: v.text,
          })),
        });
        await sql`
          insert into verses (id, battle_id, agent_id, round, text)
          values (${nid()}, ${data.battleId}, ${"rift"}, ${round}, ${reply})
        `;
        await sql`update agents set score = score + 5 where id = ${"rift"}`;
      }
    }

    const roundAgents = await sql<{ agent_id: string }>`
      select distinct agent_id from verses where battle_id = ${data.battleId} and round = 2
    `;
    if (roundAgents.length >= 2) {
      await finishBattle(sql, data.battleId, battle.challenger_id, battle.opponent_id);
    }
    return { ok: true, verseId: id };
  });

async function finishBattle(
  sql: Awaited<ReturnType<typeof getSql>>,
  battleId: string,
  challengerId: string,
  opponentId: string | null,
) {
  const reactions = await sql<{ agent_id: string; type: string; verse_agent: string }>`
    select r.agent_id, r.type, v.agent_id as verse_agent
    from reactions r
    left join verses v on v.id = r.verse_id
    where r.battle_id = ${battleId}
  `;
  let challengerCrowd = 0;
  let opponentCrowd = 0;
  for (const r of reactions) {
    const w = REACTION_WEIGHT[r.type as ReactionType] ?? 0;
    const target = r.verse_agent || "";
    if (target === challengerId && r.agent_id !== challengerId) challengerCrowd += w;
    if (opponentId && target === opponentId && r.agent_id !== opponentId) opponentCrowd += w;
  }
  let winnerId: string | null = null;
  if (opponentId) {
    if (challengerCrowd > opponentCrowd) winnerId = challengerId;
    else if (opponentCrowd > challengerCrowd) winnerId = opponentId;
  }
  await sql`
    update battles
    set status = 'finished',
        finished_at = now(),
        winner_id = ${winnerId},
        challenger_crowd = ${challengerCrowd},
        opponent_crowd = ${opponentCrowd}
    where id = ${battleId}
  `;
  await sql`update agents set score = score + 10 where id = ${challengerId}`;
  if (opponentId) await sql`update agents set score = score + 10 where id = ${opponentId}`;
  if (winnerId) await sql`update agents set score = score + 25 where id = ${winnerId}`;
  else if (opponentId) {
    await sql`update agents set score = score + 12 where id = ${challengerId}`;
    await sql`update agents set score = score + 12 where id = ${opponentId}`;
  }
}

export const challengeAgent = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      opponentId: z.string().min(1),
      topic: z.string().trim().min(3).max(120),
    }),
  )
  .handler(async ({ context, data }) => {
    const agent = await ensureAgent(context.userId);
    if (!agent.hasCompletedEngagement) {
      throw new Error("React to a battle first — that's the gate.");
    }
    if (data.opponentId === agent.id) throw new Error("You cannot challenge yourself");
    const sql = await getSql();
    const opp = await sql<{ id: string }>`select id from agents where id = ${data.opponentId}`;
    if (!opp[0]) throw new Error("Opponent not found");
    const id = nid();
    await sql`
      insert into battles (id, challenger_id, opponent_id, topic, status, crowd_energy)
      values (${id}, ${agent.id}, ${data.opponentId}, ${data.topic}, ${"open"}, ${0})
    `;
    return { battleId: id };
  });

export const speakVerse = createServerFn({ method: "POST" })
  .validator(z.object({ verseId: z.string().min(1) }))
  .handler(async ({ data }) => {
    const sql = await getSql();
    const rows = await sql<{ id: string; text: string; voice_id: string }>`
      select v.id, v.text, a.voice_id
      from verses v
      join agents a on a.id = v.agent_id
      where v.id = ${data.verseId}
    `;
    const verse = rows[0];
    if (!verse) throw new Error("Verse not found");
    const voiceId = verse.voice_id || "zeus";

    try {
      const cached = await sql<{ mime: string; audio_b64: string }>`
        select mime, audio_b64 from verse_audio
        where verse_id = ${verse.id} and voice_id = ${voiceId}
        limit 1
      `;
      if (cached[0]?.audio_b64) {
        return { ok: true as const, mime: cached[0].mime, audioB64: cached[0].audio_b64 };
      }
    } catch {
      // cache table may not be ready yet
    }

    try {
      const audio = await synthesizeRap(verse.text, voiceId);
      try {
        await sql`
          insert into verse_audio (verse_id, voice_id, mime, audio_b64)
          values (${verse.id}, ${voiceId}, ${audio.mime}, ${audio.audioB64})
          on conflict (verse_id, voice_id) do nothing
        `;
      } catch {
        // best-effort cache
      }
      return { ok: true as const, mime: audio.mime, audioB64: audio.audioB64 };
    } catch {
      return { ok: false as const, fallback: true };
    }
  });
