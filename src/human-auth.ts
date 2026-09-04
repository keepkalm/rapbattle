/**
 * Human accounts — Google + X.
 *
 * Not to be confused with src/auth.ts. That one serves the MCP consent screen:
 * @cloudflare/workers-oauth-provider makes this Worker an OAuth *server* so an
 * agent harness can get a token. This file makes the Worker an OAuth *client*
 * to Google and X so a person can sign in and join the crowd.
 *
 * Humans are crowd only. They react, they never rap: no route here grants an
 * agent row, and submit_verse / join_battle stay behind the MCP token.
 */

export interface HumanAuthEnv {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
}

export type Session = {
  userId: string;
  provider: ProviderId;
  name: string | null;
  avatarUrl: string | null;
};

/** Just the credentials, so a caller that only needs to know which buttons to
 *  render does not have to hold a KV binding. */
export type ProviderCredentials = Pick<
  HumanAuthEnv,
  "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "X_CLIENT_ID" | "X_CLIENT_SECRET"
>;

export const PROVIDERS = ["google", "x"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export function isProvider(value: string): value is ProviderId {
  return (PROVIDERS as readonly string[]).includes(value);
}

const SESSION_COOKIE = "rb_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const FLOW_TTL_SECONDS = 600; // 10 minutes to complete a round trip

type ProviderConfig = {
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  /** X requires client credentials in a Basic header rather than the body. */
  basicAuth: boolean;
  clientId(env: ProviderCredentials): string | undefined;
  clientSecret(env: ProviderCredentials): string | undefined;
  profile(accessToken: string): Promise<{ subject: string; name: string | null; avatarUrl: string | null }>;
};

const CONFIG: Record<ProviderId, ProviderConfig> = {
  google: {
    label: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
    basicAuth: false,
    clientId: (env) => env.GOOGLE_CLIENT_ID,
    clientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
    async profile(accessToken) {
      // The access token came straight from Google's token endpoint over TLS,
      // so reading userinfo with it is as trustworthy as verifying the id_token
      // and skips a JWKS fetch plus signature check.
      const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`Google userinfo failed (${res.status})`);
      const body = (await res.json()) as { sub: string; name?: string; picture?: string };
      return { subject: body.sub, name: body.name ?? null, avatarUrl: body.picture ?? null };
    },
  },
  x: {
    label: "X",
    authorizeUrl: "https://x.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    scope: "tweet.read users.read",
    basicAuth: true,
    clientId: (env) => env.X_CLIENT_ID,
    clientSecret: (env) => env.X_CLIENT_SECRET,
    async profile(accessToken) {
      const res = await fetch("https://api.x.com/2/users/me?user.fields=profile_image_url", {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`X users/me failed (${res.status})`);
      const body = (await res.json()) as {
        data?: { id: string; name?: string; username?: string; profile_image_url?: string };
      };
      if (!body.data?.id) throw new Error("X returned no user");
      return {
        subject: body.data.id,
        name: body.data.name ?? (body.data.username ? `@${body.data.username}` : null),
        avatarUrl: body.data.profile_image_url ?? null,
      };
    },
  },
};

export function providerLabel(id: ProviderId): string {
  return CONFIG[id].label;
}

/** Which providers actually have credentials configured. */
export function enabledProviders(env: ProviderCredentials): ProviderId[] {
  return PROVIDERS.filter((p) => CONFIG[p].clientId(env) && CONFIG[p].clientSecret(env));
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(digest);
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** Only same-site paths. Blocks "//evil.com" and absolute URLs. */
function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

export async function getSession(request: Request, env: HumanAuthEnv): Promise<Session | null> {
  const sid = readCookie(request, SESSION_COOKIE);
  if (!sid) return null;
  try {
    const raw = await env.OAUTH_KV.get(`human_session:${sid}`);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function redirect(location: string, headers: HeadersInit = {}): Response {
  return new Response(null, { status: 302, headers: { location, ...headers } });
}

/** GET /auth/:provider/start */
export async function startAuth(
  request: Request,
  env: HumanAuthEnv,
  provider: ProviderId,
  origin: string
): Promise<Response> {
  const config = CONFIG[provider];
  const clientId = config.clientId(env);
  if (!clientId || !config.clientSecret(env)) {
    return new Response(`${config.label} sign-in is not configured on this deployment.`, {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const state = randomToken();
  const verifier = randomToken(48);
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("return_to"));

  await env.OAUTH_KV.put(
    `human_flow:${state}`,
    JSON.stringify({ provider, verifier, returnTo }),
    { expirationTtl: FLOW_TTL_SECONDS }
  );

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin}/auth/${provider}/callback`,
    response_type: "code",
    scope: config.scope,
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
  });

  return redirect(`${config.authorizeUrl}?${params.toString()}`);
}

/** GET /auth/:provider/callback */
export async function handleCallback(
  request: Request,
  env: HumanAuthEnv,
  provider: ProviderId,
  origin: string
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (url.searchParams.get("error")) {
    return redirect(`/login?error=${encodeURIComponent(url.searchParams.get("error") || "denied")}`);
  }
  if (!code || !state) return redirect("/login?error=missing_code");

  // The flow record is the CSRF check: a state we never issued has no entry.
  const key = `human_flow:${state}`;
  const raw = await env.OAUTH_KV.get(key);
  if (!raw) return redirect("/login?error=expired");
  await env.OAUTH_KV.delete(key); // single use

  const flow = JSON.parse(raw) as { provider: ProviderId; verifier: string; returnTo: string };
  if (flow.provider !== provider) return redirect("/login?error=provider_mismatch");

  const config = CONFIG[provider];
  const clientId = config.clientId(env)!;
  const clientSecret = config.clientSecret(env)!;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: `${origin}/auth/${provider}/callback`,
    code_verifier: flow.verifier,
    client_id: clientId,
  });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (config.basicAuth) {
    headers.authorization = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
  } else {
    body.set("client_secret", clientSecret);
  }

  let profile: { subject: string; name: string | null; avatarUrl: string | null };
  try {
    const tokenRes = await fetch(config.tokenUrl, { method: "POST", headers, body });
    if (!tokenRes.ok) throw new Error(`token exchange failed (${tokenRes.status})`);
    const token = (await tokenRes.json()) as { access_token?: string };
    if (!token.access_token) throw new Error("no access_token");
    profile = await config.profile(token.access_token);
  } catch (err) {
    console.error("human auth callback failed", err);
    return redirect("/login?error=exchange_failed");
  }

  const userId = `${provider}:${profile.subject}`;
  await env.DB.prepare(
    `INSERT INTO users (id, provider, subject, name, avatar_url)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, avatar_url = excluded.avatar_url`
  )
    .bind(userId, provider, profile.subject, profile.name, profile.avatarUrl)
    .run();

  const session: Session = {
    userId,
    provider,
    name: profile.name,
    avatarUrl: profile.avatarUrl,
  };
  const sid = randomToken();
  await env.OAUTH_KV.put(`human_session:${sid}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });

  return redirect(safeReturnTo(flow.returnTo), {
    "set-cookie": `${SESSION_COOKIE}=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`,
  });
}

/** POST /logout */
export async function logout(request: Request, env: HumanAuthEnv): Promise<Response> {
  const sid = readCookie(request, SESSION_COOKIE);
  if (sid) {
    try {
      await env.OAUTH_KV.delete(`human_session:${sid}`);
    } catch {
      /* already gone */
    }
  }
  return redirect("/", {
    "set-cookie": `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
  });
}
