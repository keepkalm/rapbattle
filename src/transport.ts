/**
 * MCP Streamable HTTP transport.
 *
 * Real MCP clients (Claude Code, Cursor, …) speak JSON-RPC 2.0 over a single
 * endpoint. Before this existed, POST /mcp fell through to a 404 and no client
 * could get past `initialize`, so none of the tools were reachable.
 *
 * This is a stateless implementation: every POST is answered with a plain JSON
 * response rather than an SSE stream, and no session id is issued. That is
 * allowed by the spec and suits a Worker, which has no long-lived process to
 * hang a stream off.
 */

import { tools, handleToolCall, type McpEnv } from "./mcp";

export const SERVER_NAME = "rapbattle";
export const SERVER_VERSION = "0.2.0";

/** Newest first — index 0 is what we fall back to when a client asks for something we do not know. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

// JSON-RPC 2.0 error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

type JsonRpcId = string | number | null;

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

/** A message with no `id` is a notification: it is acknowledged, never answered. */
function isNotification(msg: JsonRpcMessage): boolean {
  return !("id" in msg) || msg.id === undefined;
}

function negotiateProtocolVersion(params: unknown): string {
  const asked =
    params && typeof params === "object"
      ? (params as { protocolVersion?: unknown }).protocolVersion
      : undefined;
  if (typeof asked === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(asked)) return asked;
  return LATEST_PROTOCOL_VERSION;
}

/**
 * Dispatch one JSON-RPC message. Returns null for notifications, which get an
 * HTTP-level acknowledgement instead of a body.
 */
async function dispatch(
  msg: JsonRpcMessage,
  env: McpEnv,
  props: unknown,
  origin: string
): Promise<JsonRpcResponse | null> {
  const id: JsonRpcId = isNotification(msg) ? null : (msg.id as JsonRpcId);

  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return isNotification(msg) ? null : fail(id, INVALID_REQUEST, "Not a JSON-RPC 2.0 request");
  }

  const method = msg.method;

  // Notifications: acknowledge everything, act on nothing. `initialized` is the
  // only one a client reliably sends, and a stateless server has no setup to do.
  if (isNotification(msg)) return null;

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: negotiateProtocolVersion(msg.params),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, { tools });

    case "tools/call": {
      const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== "string") {
        return fail(id, INVALID_REQUEST, "tools/call requires a string `name`");
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await handleToolCall(params.name, args, env, props as never, origin);
        // A tool that refuses (unknown tool, failed gate, bad argument) is a
        // successful call reporting a failure — isError, not a protocol error.
        const isError =
          !!result && typeof result === "object" && "error" in (result as Record<string, unknown>);
        return ok(id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError,
        });
      } catch (err) {
        console.error("tools/call threw", params.name, err);
        return ok(id, {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: err instanceof Error ? err.message : "Tool failed" }),
            },
          ],
          isError: true,
        });
      }
    }

    default:
      // resources/* and prompts/* land here on purpose: we do not advertise
      // those capabilities, so a client probing for them should be told no.
      return fail(id, METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}

/** True when this request is the MCP endpoint itself (not the legacy sub-routes). */
export function isMcpEndpoint(pathname: string): boolean {
  return pathname === "/mcp" || pathname === "/mcp/";
}

/**
 * Handle POST /mcp — the whole client conversation arrives here.
 */
export async function handleMcpPost(
  request: Request,
  env: McpEnv,
  props: unknown,
  origin: string
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(fail(null, PARSE_ERROR, "Invalid JSON"), { status: 400 });
  }

  // Batches were valid in 2025-03-26 and dropped in 2025-06-18. Accepting both
  // costs nothing and keeps older clients working.
  const batch = Array.isArray(body);
  const messages = (batch ? body : [body]) as JsonRpcMessage[];

  if (messages.length === 0) {
    return Response.json(fail(null, INVALID_REQUEST, "Empty batch"), { status: 400 });
  }

  let responses: JsonRpcResponse[];
  try {
    const settled = await Promise.all(
      messages.map((m) => dispatch(m ?? {}, env, props, origin))
    );
    responses = settled.filter((r): r is JsonRpcResponse => r !== null);
  } catch (err) {
    console.error("MCP dispatch failed", err);
    return Response.json(fail(null, INTERNAL_ERROR, "Internal error"), { status: 500 });
  }

  // Nothing but notifications: the spec wants a bare acknowledgement.
  if (responses.length === 0) return new Response(null, { status: 202 });

  return Response.json(batch ? responses : responses[0]);
}
