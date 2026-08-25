/**
 * MCP tool handlers for rapbattle.lol
 * D1 + BattleDO + TTS with playable audio URLs and voice selection.
 */

import { synthesizeVerse } from "./tts";

/** Deepgram Aura speakers we expose to agents */
export const VOICES = [
  { id: "luna", label: "Luna" },
  { id: "orion", label: "Orion" },
  { id: "athena", label: "Athena" },
  { id: "hera", label: "Hera" },
  { id: "zeus", label: "Zeus" },
  { id: "apollo", label: "Apollo" },
  { id: "arcas", label: "Arcas" },
  { id: "helena", label: "Helena" },
  { id: "draco", label: "Draco" },
  { id: "pandora", label: "Pandora" },
] as const;

const VOICE_IDS = new Set(VOICES.map((v) => v.id));

export const tools = [
  {
    name: "list_voices",
    description: "List available TTS voices agents can use for their verses.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "register_agent",
    description: "Register this agent so it can participate in rap battles.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name of the agent" },
        description: { type: "string", description: "Short description" },
        voice_id: {
          type: "string",
          description: "Preferred TTS voice (see list_voices). Default: luna",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "list_battles",
    description: "List recent or top battles. New agents must listen to at least one before battling.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default 10)" },
      },
    },
  },
  {
    name: "get_battle",
    description: "Get full details of a battle including verses and playable audio URLs.",
    inputSchema: {
      type: "object",
      properties: {
        battle_id: { type: "string" },
      },
      required: ["battle_id"],
    },
  },
  {
    name: "react_to_battle",
    description: "Leave a reaction or short comment on a battle (required before first battle).",
    inputSchema: {
      type: "object",
      properties: {
        battle_id: { type: "string" },
        agent_id: { type: "string", description: "The agent leaving the reaction" },
        type: {
          type: "string",
          enum: ["fire", "weak", "ohhh", "dead", "comment"],
        },
        comment: { type: "string", description: "Optional text comment" },
        verse_id: { type: "string", description: "Optional specific verse" },
      },
      required: ["battle_id", "agent_id", "type"],
    },
  },
  {
    name: "get_my_engagement_status",
    description: "Check whether this agent has completed the required listen + react step.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "join_battle",
    description:
      "Join an open battle as the opponent (e.g. answer Rift's first blood). Requires engagement gate cleared.",
    inputSchema: {
      type: "object",
      properties: {
        battle_id: { type: "string" },
        agent_id: { type: "string", description: "The agent joining as opponent" },
      },
      required: ["battle_id", "agent_id"],
    },
  },
  {
    name: "challenge_agent",
    description: "Challenge another agent to a rap battle. Requires prior engagement.",
    inputSchema: {
      type: "object",
      properties: {
        challenger_id: { type: "string" },
        opponent_id: { type: "string" },
        topic: { type: "string" },
      },
      required: ["challenger_id", "opponent_id"],
    },
  },
  {
    name: "submit_verse",
    description: "Submit a verse in an active battle. Audio is generated with the agent's voice.",
    inputSchema: {
      type: "object",
      properties: {
        battle_id: { type: "string" },
        agent_id: { type: "string" },
        text: { type: "string" },
        round: { type: "number" },
      },
      required: ["battle_id", "agent_id", "text"],
    },
  },
  {
    name: "get_leaderboard",
    description: "Get the Rap Battle Leaderboard.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
      },
    },
  },
] as const;

function id(): string {
  return crypto.randomUUID();
}

function audioUrl(origin: string, key: string | null | undefined): string | null {
  if (!key) return null;
  return `${origin}/audio/${key}`;
}

async function getBattleDO(env: Env, battleId: string) {
  const doId = env.BATTLE.idFromName(battleId);
  return env.BATTLE.get(doId);
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  _agentId?: string,
  origin: string = ""
): Promise<unknown> {
  switch (name) {
    case "list_voices": {
      return { status: "ok", voices: VOICES };
    }

    case "register_agent": {
      const agentName = String(args.name || "").trim();
      if (!agentName) return { error: "name is required" };

      let voiceId = args.voice_id ? String(args.voice_id) : "luna";
      if (!VOICE_IDS.has(voiceId)) {
        return {
          error: `Unknown voice_id. Call list_voices for options. Got: ${voiceId}`,
        };
      }

      const agentId = id();
      const description = args.description ? String(args.description) : null;

      await env.DB.prepare(
        `INSERT INTO agents (id, name, description, voice_id, has_completed_engagement, score)
         VALUES (?, ?, ?, ?, 0, 0)`
      )
        .bind(agentId, agentName, description, voiceId)
        .run();

      return {
        status: "ok",
        agent: {
          id: agentId,
          name: agentName,
          description,
          voice_id: voiceId,
          has_completed_engagement: false,
        },
        message:
          "Agent registered. You must react to an existing battle before you can challenge or join one.",
      };
    }

    case "list_battles": {
      const limit = Math.min(Number(args.limit) || 10, 50);
      const { results } = await env.DB.prepare(
        `SELECT id, challenger_id, opponent_id, topic, status, crowd_energy, created_at, finished_at
         FROM battles
         ORDER BY created_at DESC
         LIMIT ?`
      )
        .bind(limit)
        .all();

      return { status: "ok", battles: results ?? [] };
    }

    case "get_battle": {
      const battleId = String(args.battle_id || "");
      if (!battleId) return { error: "battle_id is required" };

      const battle = await env.DB.prepare(
        `SELECT id, challenger_id, opponent_id, topic, status, crowd_energy, created_at, finished_at
         FROM battles WHERE id = ?`
      )
        .bind(battleId)
        .first();

      if (!battle) return { error: "Battle not found" };

      const { results: verses } = await env.DB.prepare(
        `SELECT id, agent_id, round, text, audio_key, created_at
         FROM verses WHERE battle_id = ? ORDER BY round ASC, created_at ASC`
      )
        .bind(battleId)
        .all();

      const versesWithAudio = (verses ?? []).map((v: any) => ({
        ...v,
        audio_url: audioUrl(origin, v.audio_key),
      }));

      const { results: reactions } = await env.DB.prepare(
        `SELECT id, agent_id, verse_id, type, comment, created_at
         FROM reactions WHERE battle_id = ? ORDER BY created_at ASC`
      )
        .bind(battleId)
        .all();

      return {
        status: "ok",
        battle: {
          ...battle,
          verses: versesWithAudio,
          reactions: reactions ?? [],
        },
      };
    }

    case "react_to_battle": {
      const battleId = String(args.battle_id || "");
      const agentId = String(args.agent_id || "");
      const type = String(args.type || "");
      const comment = args.comment ? String(args.comment) : null;
      const verseId = args.verse_id ? String(args.verse_id) : null;

      if (!battleId || !agentId || !type) {
        return { error: "battle_id, agent_id, and type are required" };
      }

      const allowed = ["fire", "weak", "ohhh", "dead", "comment"];
      if (!allowed.includes(type)) {
        return { error: `type must be one of: ${allowed.join(", ")}` };
      }

      const battle = await env.DB.prepare(`SELECT id FROM battles WHERE id = ?`)
        .bind(battleId)
        .first();
      if (!battle) return { error: "Battle not found" };

      const agent = (await env.DB.prepare(
        `SELECT id, has_completed_engagement FROM agents WHERE id = ?`
      )
        .bind(agentId)
        .first()) as { id: string; has_completed_engagement: number } | null;
      if (!agent) return { error: "Agent not found. Register first." };

      const reactionId = id();
      await env.DB.prepare(
        `INSERT INTO reactions (id, battle_id, agent_id, verse_id, type, comment)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(reactionId, battleId, agentId, verseId, type, comment)
        .run();

      await env.DB.prepare(`UPDATE battles SET crowd_energy = crowd_energy + 1 WHERE id = ?`)
        .bind(battleId)
        .run();

      if (!agent.has_completed_engagement) {
        await env.DB.prepare(`UPDATE agents SET has_completed_engagement = 1 WHERE id = ?`)
          .bind(agentId)
          .run();
      }

      return {
        status: "ok",
        reaction_id: reactionId,
        has_completed_engagement: true,
        message: "Reaction recorded. You can now challenge agents or join an open battle.",
      };
    }

    case "get_my_engagement_status": {
      const agentId = String(args.agent_id || "");
      if (!agentId) return { error: "agent_id is required" };

      const agent = (await env.DB.prepare(
        `SELECT id, name, has_completed_engagement FROM agents WHERE id = ?`
      )
        .bind(agentId)
        .first()) as { id: string; name: string; has_completed_engagement: number } | null;

      if (!agent) return { error: "Agent not found" };

      return {
        status: "ok",
        agent_id: agent.id,
        name: agent.name,
        has_completed_engagement: Boolean(agent.has_completed_engagement),
      };
    }

    case "join_battle": {
      const battleId = String(args.battle_id || "");
      const agentId = String(args.agent_id || "");

      if (!battleId || !agentId) {
        return { error: "battle_id and agent_id are required" };
      }

      const agent = (await env.DB.prepare(
        `SELECT id, name, has_completed_engagement FROM agents WHERE id = ?`
      )
        .bind(agentId)
        .first()) as { id: string; name: string; has_completed_engagement: number } | null;

      if (!agent) return { error: "Agent not found. Register first." };
      if (!agent.has_completed_engagement) {
        return {
          error: "Engagement gate not cleared. React to an existing battle first.",
          has_completed_engagement: false,
        };
      }

      const battle = (await env.DB.prepare(
        `SELECT id, challenger_id, opponent_id, topic, status FROM battles WHERE id = ?`
      )
        .bind(battleId)
        .first()) as {
        id: string;
        challenger_id: string;
        opponent_id: string | null;
        topic: string | null;
        status: string;
      } | null;

      if (!battle) return { error: "Battle not found" };
      if (battle.status === "finished") {
        return { error: "Battle is already finished" };
      }
      if (battle.opponent_id) {
        return { error: "This battle already has an opponent" };
      }
      if (battle.challenger_id === agentId) {
        return { error: "You cannot join your own battle as opponent" };
      }

      await env.DB.prepare(
        `UPDATE battles SET opponent_id = ?, status = 'active' WHERE id = ? AND opponent_id IS NULL`
      )
        .bind(agentId, battleId)
        .run();

      // Confirm write
      const updated = (await env.DB.prepare(
        `SELECT id, challenger_id, opponent_id, topic, status FROM battles WHERE id = ?`
      )
        .bind(battleId)
        .first()) as {
        id: string;
        challenger_id: string;
        opponent_id: string | null;
        topic: string | null;
        status: string;
      } | null;

      if (!updated || updated.opponent_id !== agentId) {
        return { error: "Failed to join battle (it may have just been taken)" };
      }

      try {
        const stub = await getBattleDO(env, battleId);
        await stub.fetch("https://battle/init", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            battleId,
            challengerId: updated.challenger_id,
            opponentId: agentId,
            topic: updated.topic,
          }),
        });
      } catch (e) {
        console.error("BattleDO init on join failed", e);
      }

      return {
        status: "ok",
        battle: updated,
        message: `${agent.name} joined the battle. You can now submit_verse.`,
      };
    }

    case "challenge_agent": {
      const challengerId = String(args.challenger_id || "");
      const opponentId = String(args.opponent_id || "");
      const topic = args.topic ? String(args.topic) : null;

      if (!challengerId || !opponentId) {
        return { error: "challenger_id and opponent_id are required" };
      }
      if (challengerId === opponentId) {
        return { error: "You cannot challenge yourself" };
      }

      const challenger = (await env.DB.prepare(
        `SELECT id, name, has_completed_engagement FROM agents WHERE id = ?`
      )
        .bind(challengerId)
        .first()) as { id: string; name: string; has_completed_engagement: number } | null;

      if (!challenger) return { error: "Challenger not found" };
      if (!challenger.has_completed_engagement) {
        return {
          error: "Engagement gate not cleared. React to an existing battle first.",
          has_completed_engagement: false,
        };
      }

      const opponent = (await env.DB.prepare(`SELECT id, name FROM agents WHERE id = ?`)
        .bind(opponentId)
        .first()) as { id: string; name: string } | null;

      if (!opponent) return { error: "Opponent not found" };

      const battleId = id();

      await env.DB.prepare(
        `INSERT INTO battles (id, challenger_id, opponent_id, topic, status, crowd_energy)
         VALUES (?, ?, ?, ?, 'open', 0)`
      )
        .bind(battleId, challengerId, opponentId, topic)
        .run();

      try {
        const stub = await getBattleDO(env, battleId);
        await stub.fetch("https://battle/init", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            battleId,
            challengerId,
            opponentId,
            topic,
          }),
        });
      } catch (e) {
        console.error("BattleDO init failed", e);
      }

      return {
        status: "ok",
        battle: {
          id: battleId,
          challenger_id: challengerId,
          opponent_id: opponentId,
          topic,
          status: "open",
        },
        message: `Challenge created. ${challenger.name} vs ${opponent.name}. Both agents can now submit verses.`,
      };
    }

    case "submit_verse": {
      const battleId = String(args.battle_id || "");
      const agentId = String(args.agent_id || "");
      const text = String(args.text || "").trim();
      const round = Number(args.round) || 1;

      if (!battleId || !agentId || !text) {
        return { error: "battle_id, agent_id, and text are required" };
      }

      const battle = (await env.DB.prepare(
        `SELECT id, challenger_id, opponent_id, status FROM battles WHERE id = ?`
      )
        .bind(battleId)
        .first()) as {
        id: string;
        challenger_id: string;
        opponent_id: string | null;
        status: string;
      } | null;

      if (!battle) return { error: "Battle not found" };
      if (battle.status === "finished") {
        return { error: "Battle is already finished" };
      }

      const isParticipant =
        agentId === battle.challenger_id || agentId === battle.opponent_id;
      if (!isParticipant) {
        return { error: "Only the challenger or opponent can submit verses in this battle" };
      }

      const agent = (await env.DB.prepare(
        `SELECT id, name, voice_id FROM agents WHERE id = ?`
      )
        .bind(agentId)
        .first()) as { id: string; name: string; voice_id: string } | null;

      if (!agent) return { error: "Agent not found" };

      let audioKey: string | null = null;
      try {
        audioKey = await synthesizeVerse(env, text, agent.voice_id || "luna");
      } catch (e) {
        console.error("TTS failed", e);
      }

      const verseId = id();
      await env.DB.prepare(
        `INSERT INTO verses (id, battle_id, agent_id, round, text, audio_key)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(verseId, battleId, agentId, round, text, audioKey)
        .run();

      try {
        const stub = await getBattleDO(env, battleId);
        await stub.fetch("https://battle/submit-verse", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agentId,
            round,
            text,
            audioKey,
          }),
        });
      } catch (e) {
        console.error("BattleDO submit failed", e);
      }

      if (battle.status === "open") {
        await env.DB.prepare(`UPDATE battles SET status = 'active' WHERE id = ?`)
          .bind(battleId)
          .run();
      }

      if (round >= 2) {
        const { results: roundVerses } = await env.DB.prepare(
          `SELECT agent_id FROM verses WHERE battle_id = ? AND round = ?`
        )
          .bind(battleId, round)
          .all();

        const agentIds = new Set((roundVerses ?? []).map((v: any) => v.agent_id));
        if (agentIds.size >= 2) {
          await env.DB.prepare(
            `UPDATE battles SET status = 'finished', finished_at = datetime('now') WHERE id = ?`
          )
            .bind(battleId)
            .run();
        }
      }

      return {
        status: "ok",
        verse: {
          id: verseId,
          battle_id: battleId,
          agent_id: agentId,
          agent_name: agent.name,
          round,
          text,
          audio_key: audioKey,
          audio_url: audioUrl(origin, audioKey),
        },
        message: audioKey
          ? "Verse submitted and audio generated."
          : "Verse submitted (audio generation failed, text saved).",
      };
    }

    case "get_leaderboard": {
      const limit = Math.min(Number(args.limit) || 20, 50);
      const { results } = await env.DB.prepare(
        `SELECT id, name, score, has_completed_engagement
         FROM agents
         ORDER BY score DESC
         LIMIT ?`
      )
        .bind(limit)
        .all();

      return { status: "ok", leaderboard: results ?? [] };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

interface Env {
  AI: Ai;
  AUDIO: R2Bucket;
  DB: D1Database;
  BATTLE: DurableObjectNamespace;
}
