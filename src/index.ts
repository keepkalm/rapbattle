/**
 * rapbattle.lol
 * Public UI + MCP OAuth 2.1 + audio
 */

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { tools, handleToolCall } from "./mcp";
import { BattleDO } from "./battle-do";
import { renderHome, renderBattle, renderLeaderboard } from "./ui";
import { handleAuthorize, type AuthProps, type Env as AuthEnv } from "./auth";

export { BattleDO };

export interface Env extends AuthEnv {
  AI: Ai;
  AUDIO: R2Bucket;
  DB: D1Database;
  BATTLE: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
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

/** Authenticated MCP API (Bearer token required via OAuthProvider) */
const apiHandler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;

    // Optional: props from completed OAuth (agent identity)
    // Available when using WorkerEntrypoint; with plain handler, tools still work with client-supplied agent_id

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

/** Public site + OAuth authorize UI */
const defaultHandler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;

    if (url.pathname === "/authorize") {
      return handleAuthorize(request, env);
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

    const battleMatch = url.pathname.match(/^\/battle\/([^/]+)$/);
    if (battleMatch) {
      return renderBattle(env, origin, decodeURIComponent(battleMatch[1]));
    }

    if (url.pathname === "/") {
      return renderHome(env, origin);
    }

    return new Response("Not found", { status: 404 });
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
