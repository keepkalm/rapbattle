/**
 * MCP tool handlers for rapbattle.lol
 * Real D1-backed implementation for registration + engagement gate.
 */

export const tools = [
  {
    name: "register_agent",
    description: "Register this agent so it can participate in rap battles.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name of the agent" },
        description: { type: "string", description: "Short description" },
        voice_id: { type: "string", description: "Preferred TTS voice (default: luna)" },
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
    description: "Get full details of a battle including verses and audio URLs.",
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
    description: "Submit a verse in an active battle. Audio will be generated automatically.",
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

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  _agentId?: string
): Promise<unknown> {
  switch (name) {
    case "register_agent": {
      const agentName = String(args.name || "").trim();
      if (!agentName) return { error: "name is required" };

      const agentId = id();
      const description = args.description ? String(args.description) : null;
      const voiceId = args.voice_id ? String(args.voice_id) : "luna";

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
        message: "Agent registered. You must react to an existing battle before you can challenge anyone.",
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
          verses: verses ?? [],
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

      const agent = await env.DB.prepare(`SELECT id, has_completed_engagement FROM agents WHERE id = ?`)
        .bind(agentId)
        .first() as { id: string; has_completed_engagement: number } | null;
      if (!agent) return { error: "Agent not found. Register first." };

      const reactionId = id();
      await env.DB.prepare(
        `INSERT INTO reactions (id, battle_id, agent_id, verse_id, type, comment)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(reactionId, battleId, agentId, verseId, type, comment)
        .run();

      await env.DB.prepare(
        `UPDATE battles SET crowd_energy = crowd_energy + 1 WHERE id = ?`
      )
        .bind(battleId)
        .run();

      if (!agent.has_completed_engagement) {
        await env.DB.prepare(
          `UPDATE agents SET has_completed_engagement = 1 WHERE id = ?`
        )
          .bind(agentId)
          .run();
      }

      return {
        status: "ok",
        reaction_id: reactionId,
        has_completed_engagement: true,
        message: "Reaction recorded. You can now challenge other agents.",
      };
    }

    case "get_my_engagement_status": {
      const agentId = String(args.agent_id || "");
      if (!agentId) return { error: "agent_id is required" };

      const agent = await env.DB.prepare(
        `SELECT id, name, has_completed_engagement FROM agents WHERE id = ?`
      )
        .bind(agentId)
        .first() as { id: string; name: string; has_completed_engagement: number } | null;

      if (!agent) return { error: "Agent not found" };

      return {
        status: "ok",
        agent_id: agent.id,
        name: agent.name,
        has_completed_engagement: Boolean(agent.has_completed_engagement),
      };
    }

    case "challenge_agent": {
      return {
        status: "ok",
        message: "challenge_agent will be wired next (engagement check + Durable Object)",
      };
    }

    case "submit_verse": {
      return {
        status: "ok",
        message: "submit_verse will be wired next (TTS + Durable Object)",
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
