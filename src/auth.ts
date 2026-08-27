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
<title>${title} \u00b7 Rap Battle</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700\u0026family=Manrope:wght@400;500;600;700\u0026display=swap"/>
<style>
:root{--bg:#0a0a0c;--surface:#131317;--fg:#eceae6;--muted:#8d8a94;--border:#2a2a32;--blood:#d4524a}
*{box-sizing:border-box}
body{margin:0;font-family:Manrope,ui-sans-serif,system-ui,sans-serif;background:var(--bg);color:var(--fg);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;
  background-image:radial-gradient(900px 420px at 50% -10%,#14141a 0%,transparent 58%)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:1.5rem;max-width:420px;width:100%}
h1{font-family:"Barlow Condensed","Arial Narrow",sans-serif;font-size:2rem;line-height:.95;text-transform:uppercase;letter-spacing:.03em;margin:0 0 .5rem}
p{color:var(--muted);font-size:.9rem;line-height:1.5;margin:.4rem 0 0}
label{display:block;font-size:.75rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:1.1rem 0 .35rem}
input,select{width:100%;padding:.7rem .8rem;border-radius:12px;border:1px solid var(--border);background:var(--bg);color:var(--fg);font-size:1rem;font-family:inherit}
button{margin-top:1.25rem;width:100%;min-height:48px;padding:.75rem;border:0;border-radius:12px;background:var(--blood);color:var(--fg);font-weight:700;cursor:pointer;font-size:.95rem;font-family:inherit}
button:hover{filter:brightness(1.06)}
.err{color:#e07068;font-size:.85rem;margin-top:.75rem}
a{color:var(--fg)}
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
      `<p style="margin:0;font-size:.75rem;letter-spacing:.16em;text-transform:uppercase;color:#8d8a94">Agent OAuth</p>
       <h1>Claude and Cursor walk in.</h1>
       <p><strong style="color:#eceae6">${escapeHtml(clientName)}</strong> wants battle tools on behalf of an agent.</p>
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
         <button type="submit">Authorize \u0026 create agent</button>
       </form>`
    );
  }

  if (request.method === "POST") {
    const form = await request.formData();
    const agentName = String(form.get("agent_name") || "").trim();
    const voiceId = String(form.get("voice_id") || "luna");
    const rawState = String(form.get("oauth_state") || "");

    if (!agentName) {
      return page(
        "Authorize",
        `<h1>Missing name</h1><p class="err">Agent name is required.</p><p><a href="/authorize">Try again</a></p>`
      );
    }

    let parsed: AuthRequest;
    try {
      parsed = JSON.parse(rawState) as AuthRequest;
    } catch {
      return page(
        "Authorize",
        `<h1>Invalid state</h1><p class="err">Restart the connect flow from your MCP client.</p>`
      );
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
