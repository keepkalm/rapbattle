/**
 * rapbattle.lol – main Worker
 * MCP server + OAuth Resource Server on Cloudflare
 */

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { tools, handleToolCall } from "./mcp";
import { BattleDO } from "./battle-do";

export { BattleDO };

export interface Env {
  AI: Ai;
  AUDIO: R2Bucket;
  DB: D1Database;
  BATTLE: DurableObjectNamespace;
}

// Simple MCP-over-HTTP handler (Streamable HTTP style)
async function mcpHandler(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  // Health / discovery
  if (request.method === "GET" && url.pathname === "/mcp") {
    return Response.json({
      name: "rapbattle",
      version: "0.1.0",
      description: "Agent vs agent rap battles",
      tools: tools.map(t => ({ name: t.name, description: t.description })),
    });
  }

  // Tool list
  if (request.method === "POST" && url.pathname === "/mcp/tools/list") {
    return Response.json({ tools });
  }

  // Tool call
  if (request.method === "POST" && url.pathname === "/mcp/tools/call") {
    const body = await request.json() as { name: string; arguments?: Record<string, unknown> };
    const result = await handleToolCall(body.name, body.arguments ?? {}, env);
    return Response.json({ content: [{ type: "text", text: JSON.stringify(result) }] });
  }

  // Protected resource metadata (RFC 9728)
  if (url.pathname === "/.well-known/oauth-protected-resource") {
    return Response.json({
      resource: new URL("/mcp", url.origin).toString(),
      authorization_servers: [url.origin],
      scopes_supported: ["mcp:battles", "mcp:react", "mcp:leaderboard"],
      bearer_methods_supported: ["header"],
    });
  }

  return new Response("Not found", { status: 404 });
}

// Temporary default export while OAuth provider is wired
// Replace with full OAuthProvider once @cloudflare/workers-oauth-provider is installed and configured
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Public routes that skip auth for now (MVP scaffolding)
    if (
      url.pathname.startsWith("/mcp") ||
      url.pathname === "/.well-known/oauth-protected-resource"
    ) {
      return mcpHandler(request, env, ctx);
    }

    // Simple public health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        service: "rapbattle.lol",
        status: "scaffolding",
        message: "MCP + battle engine coming online",
      });
    }

    return new Response("rapbattle.lol – coming soon", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  },
};

/*
  Once dependencies are installed, switch to the official pattern:

  export default new OAuthProvider({
    apiRoute: "/mcp",
    apiHandler: mcpHandler,
    defaultHandler: authHandler,          // your login / consent UI
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    // resourceMetadata etc.
  });
*/
