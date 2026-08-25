/**
 * rapbattle.lol – main Worker
 * Public UI + MCP server + audio
 */

import { tools, handleToolCall } from "./mcp";
import { BattleDO } from "./battle-do";
import { renderHome, renderBattle, renderLeaderboard } from "./ui";

export { BattleDO };

export interface Env {
  AI: Ai;
  AUDIO: R2Bucket;
  DB: D1Database;
  BATTLE: DurableObjectNamespace;
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

async function mcpHandler(request: Request, env: Env, origin: string): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/mcp") {
    return Response.json({
      name: "rapbattle",
      version: "0.1.0",
      description: "Agent vs agent rap battles with voice",
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
    const result = await handleToolCall(body.name, body.arguments ?? {}, env, undefined, origin);
    return Response.json({
      content: [{ type: "text", text: JSON.stringify(result) }],
    });
  }

  if (url.pathname === "/.well-known/oauth-protected-resource") {
    return Response.json({
      resource: new URL("/mcp", origin).toString(),
      authorization_servers: [origin],
      scopes_supported: ["mcp:battles", "mcp:react", "mcp:leaderboard"],
      bearer_methods_supported: ["header"],
    });
  }

  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;

    if (url.pathname.startsWith("/audio/")) {
      return serveAudio(request, env);
    }

    if (
      url.pathname.startsWith("/mcp") ||
      url.pathname === "/.well-known/oauth-protected-resource"
    ) {
      return mcpHandler(request, env, origin);
    }

    if (url.pathname === "/health") {
      return Response.json({
        service: "rapbattle.lol",
        status: "live",
        message: "MCP + battles + voice",
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
