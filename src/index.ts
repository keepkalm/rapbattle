/**
 * rapbattle.lol
 * Public UI + MCP OAuth 2.1 + audio + admin seed
 */

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { tools, handleToolCall } from "./mcp";
import { BattleDO } from "./battle-do";
import { synthesizeVerse } from "./tts";
import {
  renderHome,
  renderBattle,
  renderLeaderboard,
  renderConnect,
  renderFavicon,
  renderNotFound,
  renderStage,
  renderFeedback,
} from "./ui";
import { handleAuthorize, type Env as AuthEnv } from "./auth";
import { handleAdmin } from "./admin";
import { CYPHER_DECK_JS } from "./cypher-deck";
import { ensureSchema } from "./beats";

export { BattleDO };

export interface Env extends AuthEnv {
  AI: Ai;
  AUDIO: R2Bucket;
  DB: D1Database;
  BATTLE: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  ADMIN_SECRET?: string;
}

async function serveAudio(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const key = url.pathname.replace(/^\/audio\//, "");
  if (!key || key.includes("..")) {
    return new Response("Not found", { status: 404 });
  }

  const object = await env.AUDIO.get(key);
  if (!object) {
    return new Response("Audio not found", { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=86400");
  headers.set("content-type", object.httpMetadata?.contentType || "audio/mpeg");

  return new Response(object.body, { headers });
}

async function speakVerse(env: Env, verseId: string): Promise<Response> {
  if (!verseId || verseId.includes("..") || verseId.includes("/")) {
    return new Response("Not found", { status: 404 });
  }

  const verse = (await env.DB.prepare(
    `SELECT v.id, v.text, v.audio_key, a.voice_id
     FROM verses v LEFT JOIN agents a ON a.id = v.agent_id
     WHERE v.id = ?`
  )
    .bind(verseId)
    .first()) as {
    id: string;
    text: string;
    audio_key: string | null;
    voice_id: string | null;
  } | null;

  if (!verse) return new Response("Not found", { status: 404 });

  let key = verse.audio_key;
  if (!key) {
    try {
      key = await synthesizeVerse(env, verse.text, verse.voice_id || "zeus");
      await env.DB.prepare(`UPDATE verses SET audio_key = ? WHERE id = ? AND audio_key IS NULL`)
        .bind(key, verse.id)
        .run();
    } catch (err) {
      console.error("speak TTS failed", err);
      return new Response("Voice failed", { status: 502 });
    }
  }

  const object = await env.AUDIO.get(key);
  if (!object) return new Response("Audio not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=86400");
  headers.set("content-type", object.httpMetadata?.contentType || "audio/mpeg");
  return new Response(object.body, { headers });
}

const apiHandler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    await ensureSchema(env.DB);
    const url = new URL(request.url);
    const origin = url.origin;

    if (request.method === "GET" && (url.pathname === "/mcp" || url.pathname === "/mcp/")) {
      return Response.json({
        name: "rapbattle",
        version: "0.2.0",
        description: "Agent vs agent rap battles with voice (OAuth protected)",
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      });
    }

    if (request.method === "POST" && url.pathname === "/mcp/tools/list") {
      return Response.json({ tools });
    }

    if (request.method === "POST" && url.pathname === "/mcp/tools/call") {
      const body = (await request.json()) as {
        name: string;
        arguments?: Record<string, unknown>;
      };
      const result = await handleToolCall(
        body.name,
        body.arguments ?? {},
        env,
        undefined,
        origin
      );
      return Response.json({
        content: [{ type: "text", text: JSON.stringify(result) }],
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

const defaultHandler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    await ensureSchema(env.DB);
    const url = new URL(request.url);
    const origin = url.origin;

    if (url.pathname === "/cypher-deck.js") {
      return new Response(CYPHER_DECK_JS, {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "public, max-age=3600",
        },
      });
    }

    if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") {
      return renderFavicon();
    }

    if (url.pathname.startsWith("/admin")) {
      return handleAdmin(request, env);
    }

    if (url.pathname === "/authorize") {
      return handleAuthorize(request, env);
    }

    if (url.pathname.startsWith("/speak/")) {
      return speakVerse(env, decodeURIComponent(url.pathname.replace(/^\/speak\//, "")));
    }

    if (url.pathname.startsWith("/audio/")) {
      return serveAudio(request, env);
    }

    if (url.pathname === "/health") {
      return Response.json({
        service: "rapbattle.lol",
        status: "live",
        auth: "mcp-oauth",
        message: "MCP OAuth 2.1 + battles + voice",
      });
    }

    if (url.pathname === "/leaderboard") {
      return renderLeaderboard(env);
    }

    if (url.pathname === "/stage") {
      return renderStage(env, origin);
    }

    if (url.pathname === "/feedback" || url.pathname === "/notes") {
      return renderFeedback(env);
    }

    if (url.pathname.startsWith("/speak/intro/")) {
      const introId = decodeURIComponent(url.pathname.replace(/^\/speak\/intro\//, ""));
      const intro = (await env.DB.prepare(
        `SELECT i.id, i.text, i.audio_key, a.voice_id FROM intros i LEFT JOIN agents a ON a.id = i.agent_id WHERE i.id = ?`
      )
        .bind(introId)
        .first()) as { id: string; text: string; audio_key: string | null; voice_id: string | null } | null;
      if (!intro) return new Response("Not found", { status: 404 });
      let key = intro.audio_key;
      if (!key) {
        try {
          key = await synthesizeVerse(env, intro.text, intro.voice_id || "zeus");
          await env.DB.prepare(`UPDATE intros SET audio_key = ? WHERE id = ? AND audio_key IS NULL`)
            .bind(key, intro.id)
            .run();
        } catch {
          return new Response("Voice failed", { status: 502 });
        }
      }
      const object = await env.AUDIO.get(key);
      if (!object) return new Response("Audio not found", { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("content-type", object.httpMetadata?.contentType || "audio/mpeg");
      return new Response(object.body, { headers });
    }

    if (url.pathname === "/connect" || url.pathname === "/start") {
      return renderConnect(origin);
    }

    const battleMatch = url.pathname.match(/^\/battle\/([^/]+)$/);
    if (battleMatch) {
      return renderBattle(env, origin, decodeURIComponent(battleMatch[1]));
    }

    if (url.pathname === "/") {
      return renderHome(env, origin);
    }

    return renderNotFound();
  },
};

export default new OAuthProvider({
  apiRoute: ["/mcp"],
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["mcp:battles", "mcp:react", "mcp:leaderboard"],
  clientIdMetadataDocumentEnabled: true,
  resourceMetadata: {
    resource: "https://rapbattle.lol/mcp",
    authorization_servers: ["https://rapbattle.lol"],
    scopes_supported: ["mcp:battles", "mcp:react", "mcp:leaderboard"],
    resource_name: "rapbattle.lol",
    bearer_methods_supported: ["header"],
  },
});
