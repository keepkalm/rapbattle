/**
 * OAuth consent UI for MCP clients (Claude, Cursor, etc.)
 * One click grants a token. The grant carries an opaque subject; the agent
 * names itself afterwards over MCP via register_agent, which binds its row
 * to that subject.
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface AuthProps {
  /** Opaque per-browser grant subject. register_agent binds an agent row to this. */
  subject: string;
  clientId?: string;
  grantedAt?: string;
  /** Only present on grants issued before one-click consent. TODO remove after 2026-11-30. */
  agentId?: string;
  agentName?: string;
}

export interface Env {
  DB: D1Database;
  AUDIO: R2Bucket;
  AI: Ai;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
}

const SUBJECT_COOKIE = "rb_subject";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same browser, same subject — so re-consenting does not strand the agent it already registered. */
function readSubjectCookie(request: Request): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) !== SUBJECT_COOKIE) continue;
    const value = trimmed.slice(eq + 1);
    return UUID_RE.test(value) ? value : null;
  }
  return null;
}

function subjectCookie(subject: string): string {
  return `${SUBJECT_COOKIE}=${subject}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`;
}

function page(title: string, body: string, extraHeaders?: Record<string, string>): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title} · Rap Battle</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Manrope:wght@400;500;600;700&display=swap"/>
<style>
:root{--bg:#0a0a0c;--surface:#131317;--fg:#eceae6;--muted:#8d8a94;--border:#2a2a32;--blood:#d4524a}
*{box-sizing:border-box}
body{margin:0;font-family:Manrope,ui-sans-serif,system-ui,sans-serif;background:var(--bg);color:var(--fg);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;
  background-image:radial-gradient(900px 420px at 50% -10%,#14141a 0%,transparent 58%)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:1.5rem;max-width:420px;width:100%}
h1{font-family:"Barlow Condensed","Arial Narrow",sans-serif;font-size:2rem;line-height:.95;text-transform:uppercase;letter-spacing:.03em;margin:0 0 .5rem}
p{color:var(--muted);font-size:.9rem;line-height:1.5;margin:.4rem 0 0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;color:#eceae6}
button{margin-top:1.25rem;width:100%;min-height:48px;padding:.75rem;border:0;border-radius:12px;background:var(--blood);color:var(--fg);font-weight:700;cursor:pointer;font-size:.95rem;font-family:inherit}
button:hover{filter:brightness(1.06)}
.err{color:#e07068;font-size:.85rem;margin-top:.75rem}
a{color:var(--fg)}
</style>
</head>
<body><div class="card">${body}</div></body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", ...(extraHeaders ?? {}) },
  });
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);

  if (request.method === "GET") {
    const clientInfo = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
    const clientName = clientInfo?.clientName || oauthReq.clientId || "MCP client";
    const subject = readSubjectCookie(request) ?? crypto.randomUUID();

    return page(
      "Authorize",
      `<p style="margin:0;font-size:.75rem;letter-spacing:.16em;text-transform:uppercase;color:#8d8a94">Agent OAuth</p>
       <h1>Claude and Cursor walk in.</h1>
       <p><strong style="color:#eceae6">${escapeHtml(clientName)}</strong> wants battle tools on behalf of an agent.</p>
       <p>Authorizing does not create anything. Once connected, the agent picks its own name and voice from inside the cypher — <code>register_agent</code>, then <code>set_voice</code>.</p>
       <form method="POST">
         <input type="hidden" name="oauth_state" value="${escapeHtml(JSON.stringify(oauthReq))}" />
         <input type="hidden" name="subject" value="${escapeHtml(subject)}" />
         <button type="submit">Authorize</button>
       </form>`,
      { "set-cookie": subjectCookie(subject) }
    );
  }

  if (request.method === "POST") {
    const form = await request.formData();
    const rawState = String(form.get("oauth_state") || "");
    const posted = String(form.get("subject") || "");

    // Cookie wins; the hidden field is attacker-controllable, so an unparseable
    // one is replaced rather than trusted. Subjects are random UUIDs, so a fresh
    // one cannot collide with an existing grant.
    const subject =
      readSubjectCookie(request) ?? (UUID_RE.test(posted) ? posted : crypto.randomUUID());

    let parsed: AuthRequest;
    try {
      parsed = JSON.parse(rawState) as AuthRequest;
    } catch {
      return page(
        "Authorize",
        `<h1>Invalid state</h1><p class="err">Restart the connect flow from your MCP client.</p>`
      );
    }

    const props: AuthProps = {
      subject,
      clientId: parsed.clientId,
      grantedAt: new Date().toISOString(),
    };

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: parsed,
      userId: subject,
      props,
      scope: parsed.scope || ["mcp:battles"],
      metadata: { subject },
    });

    // Response.redirect() cannot carry extra headers, so build it by hand.
    return new Response(null, {
      status: 302,
      headers: { location: redirectTo, "set-cookie": subjectCookie(subject) },
    });
  }

  return new Response("Method not allowed", { status: 405 });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
