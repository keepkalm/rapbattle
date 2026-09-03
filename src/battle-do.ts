/**
 * Durable Object that owns the state of a single live battle.
 * Handles turn order, verse submission, and basic concurrency.
 */

export class BattleDO implements DurableObject {
  state: DurableObjectState;
  env: Env;
  battle: BattleState | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && path === "/init") {
      const body = await request.json() as InitBattleBody;
      this.battle = {
        id: body.battleId,
        challengerId: body.challengerId,
        opponentId: body.opponentId ?? null,
        topic: body.topic ?? null,
        status: "open",
        currentRound: 1,
        verses: [],
        crowdEnergy: 0,
      };
      await this.state.storage.put("battle", this.battle);
      return Response.json({ ok: true, battle: this.battle });
    }

    if (request.method === "POST" && path === "/submit-verse") {
      const body = await request.json() as SubmitVerseBody;
      if (!this.battle) {
        this.battle = await this.state.storage.get("battle") ?? null;
      }
      if (!this.battle) {
        return Response.json({ error: "Battle not initialized" }, { status: 400 });
      }

      this.battle.verses.push({
        agentId: body.agentId,
        round: body.round,
        text: body.text,
        audioKey: body.audioKey ?? null,
      });

      // Simple turn logic: after two verses in a round, advance or finish
      const versesThisRound = this.battle.verses.filter(v => v.round === this.battle!.currentRound);
      if (versesThisRound.length >= 2) {
        if (this.battle.currentRound >= 2) {
          this.battle.status = "finished";
        } else {
          this.battle.currentRound += 1;
        }
      }

      await this.state.storage.put("battle", this.battle);
      return Response.json({ ok: true, battle: this.battle });
    }

    if (request.method === "GET" && path === "/state") {
      if (!this.battle) {
        this.battle = await this.state.storage.get("battle") ?? null;
      }
      return Response.json(this.battle ?? { error: "No battle" });
    }

    return new Response("Not found", { status: 404 });
  }
}

interface BattleState {
  id: string;
  challengerId: string;
  opponentId: string | null;
  topic: string | null;
  status: "open" | "active" | "finished";
  currentRound: number;
  verses: Array<{
    agentId: string;
    round: number;
    text: string;
    audioKey: string | null;
  }>;
  crowdEnergy: number;
}

interface InitBattleBody {
  battleId: string;
  challengerId: string;
  opponentId?: string;
  topic?: string;
}

interface SubmitVerseBody {
  agentId: string;
  round: number;
  text: string;
  audioKey?: string;
}

interface Env {
  AI: Ai;
  AUDIO: R2Bucket;
  DB: D1Database;
  BATTLE: DurableObjectNamespace;
}
