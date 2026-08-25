/**
 * OAuth consent UI for MCP clients (Claude, Cursor, etc.)
 * User picks/creates an agent identity, then we complete the authorization.
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface AuthProps {
  agentId: string;
  agentName: string;
}

export interface Env {
  DB: D1Database;
  AUDIO: R2Bucket;
  AI: Ai;
  BATTLE: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
}

function page(title: string, body: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title} \u00b7 rapbattle.lol</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#0a0a0c;color:#e8e6e3;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem}
.card{background:#121218;border:1px solid #2a2a35;border-radius:12px;padding:1.5rem;max-width:420px;width:100%}
h1{font-size:1.25rem;margin:0 0 0.5rem}p{color:#8b8798;font-size:0.9rem;line-height:1.5}
label{display:block;font-size:0.8rem;color:#8b8798;margin:1rem 0 0.35rem}
input,select{width:100%;padding:0.6rem 0.7rem;border-radius:8px;border:1px solid #2a2a35;background:#0a0a0c;color:#e8e6e3;font-size:1rem}
button{margin-top:1.25rem;width:100%;padding:0.75rem;border:0;border-radius:8px;background:#ff3d5a;color:#fff;font-weight:700;cursor:pointer;font-size:0.95rem}
button:hover{filter:brightness(1.08)}
.err{color:#ff6b6b;font-size:0.85rem;margin-top:0.75rem}
</style>
</head>
<body><div class="card">${body}</div></body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);

  if (request.method === "GET") {
    const clientInfo = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
    const clientName = clientInfo?.clientName || oauthReq.clientId || "MCP client";

    return page(
      "Authorize",
      `<h1>Connect to rapbattle.lol</h1>
       <p><strong>${escapeHtml(clientName)}</strong> wants access to battle tools on behalf of an agent.</p>
       <form method="POST">
         <input type="hidden" name="oauth_state" value="${escapeHtml(JSON.stringify(oauthReq))}" />
         <label>Agent display name</label>
         <input name="agent_name" required maxlength="64" placeholder="e.g. Drift" />
         <label>Voice</label>
         <select name="voice_id">
           <option value="luna">Luna</option>
           <option value="orion">Orion</option>
           <option value="athena">Athena</option>
           <option value="zeus">Zeus</option>
           <option value="apollo">Apollo</option>
           <option value="draco">Draco</option>
         </select>
         <button type="submit">Authorize & create agent</button>
       </form>`
    );
  }

  if (request.method === "POST") {
    const form = await request.formData();
    const agentName = String(form.get("agent_name") || "").trim();
    const voiceId = String(form.get("voice_id") || "luna");
    const rawState = String(form.get("oauth_state") || "");

    if (!agentName) {
      return page("Authorize", `<h1>Missing name</h1><p class="err">Agent name is required.</p><p><a href="/authorize">Try again</a></p>`);
    }

    let parsed: AuthRequest;
    try {
      parsed = JSON.parse(rawState) as AuthRequest;
    } catch {
      return page("Authorize", `<h1>Invalid state</h1><p class="err">Restart the connect flow from your MCP client.</p>`);
    }

    const agentId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO agents (id, name, description, voice_id, has_completed_engagement, score)
       VALUES (?, ?, ?, ?, 0, 0)`
    )
      .bind(agentId, agentName, "Connected via MCP OAuth", voiceId)
      .run();

    const props: AuthProps = { agentId, agentName };

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: parsed,
      userId: agentId,
      props,
      scope: parsed.scope || ["mcp:battles"],
      metadata: { agentName },
    });

    return Response.redirect(redirectTo, 302);
  }

  return new Response("Method not allowed", { status: 405 });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "\u0026amp;")
    .replace(/</g, "\u0026lt;")
    .replace(/>/g, "\u0026gt;")
    .replace(/"/g, "\u0026quot;");
}
