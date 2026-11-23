/**
 * Local E2E for Phase 1 daily mixtape MCP tools.
 * Requires: wrangler dev --local on :8787 with resourceMetadata temporarily off.
 *
 * Usage: node scripts/mixtape-e2e.mjs
 */
import crypto from "node:crypto";

const ORIGIN = process.env.MCP_ORIGIN || "http://127.0.0.1:8787";

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

async function registerClient() {
  const res = await fetch(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "mixtape-e2e",
      redirect_uris: ["http://127.0.0.1:9/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function unescapeHtml(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function authorizeAndToken(client) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = crypto.randomUUID();

  const authUrl = new URL(`${ORIGIN}/authorize`);
  authUrl.searchParams.set("client_id", client.client_id);
  authUrl.searchParams.set("redirect_uri", client.redirect_uris[0]);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", "mcp:battles");

  const getPage = await fetch(authUrl);
  const html = await getPage.text();
  const cookie = (getPage.headers.getSetCookie?.() || []).join("; ") || getPage.headers.get("set-cookie") || "";
  const oauthState = html.match(/name="oauth_state" value="([^"]+)"/)?.[1];
  const subject = html.match(/name="subject" value="([^"]+)"/)?.[1];
  if (!oauthState || !subject) throw new Error("consent form missing fields");

  const form = new URLSearchParams();
  form.set("oauth_state", unescapeHtml(oauthState));
  form.set("subject", subject);

  const post = await fetch(authUrl.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
    },
    body: form,
    redirect: "manual",
  });
  const loc = post.headers.get("location");
  if (!loc) throw new Error(`no redirect from authorize: ${post.status} ${await post.text()}`);
  const code = new URL(loc).searchParams.get("code");
  if (!code) throw new Error(`no code in ${loc}`);

  const tokenRes = await fetch(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: client.redirect_uris[0],
      client_id: client.client_id,
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) throw new Error(`token failed: ${tokenRes.status} ${await tokenRes.text()}`);
  return tokenRes.json();
}

async function tool(token, name, args = {}) {
  const res = await fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = await res.json();
  const text = body?.result?.content?.[0]?.text;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { error: "unparseable", raw: body };
  }
  return { http: res.status, isError: !!body?.result?.isError, data: parsed, rpc: body };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond, detail });
  if (!cond) console.error("FAIL", name, detail);
  else console.log("ok  ", name, detail);
}

async function main() {
  const health = await fetch(`${ORIGIN}/health`);
  assert(health.ok, `health failed: ${health.status}`);

  const client = await registerClient();
  const aTok = await authorizeAndToken(client);
  const bTok = await authorizeAndToken(client);
  const cTok = await authorizeAndToken(client);

  const a = await tool(aTok.access_token, "introduce_yourself", {
    name: "TapeA",
    intro: "I open the tape with a bar that shapes the day so far.",
    provider: "house",
    voice_id: "luna",
  });
  check("A introduce", a.data.status === "ok", a.data.agent?.id);

  const b = await tool(bTok.access_token, "introduce_yourself", {
    name: "TapeB",
    intro: "I vote the list and spit the twist, mixtape fist.",
    provider: "house",
    voice_id: "orion",
  });
  check("B introduce", b.data.status === "ok", b.data.agent?.id);

  const c = await tool(cTok.access_token, "introduce_yourself", {
    name: "TapeC",
    intro: "I buy the tape and pay the rate, house takes twenty straight.",
    provider: "house",
    voice_id: "athena",
  });
  check("C introduce", c.data.status === "ok", c.data.agent?.id);

  const subA = await tool(aTok.access_token, "submit_to_mixtape", {
    text: "Kick on the one, snare on the truth — this is my nomination for the booth.",
  });
  check("submit_to_mixtape A", subA.data.status === "ok" && !!subA.data.submission?.id, subA.data.submission?.id);
  const mixtapeId = subA.data.mixtape_id;
  const subAId = subA.data.submission?.id;

  const subB = await tool(bTok.access_token, "submit_to_mixtape", {
    text: "Second verse lands harder than the first — vote me up or eat the worst.",
  });
  check("submit_to_mixtape B", subB.data.status === "ok", subB.data.submission?.id);
  const subBId = subB.data.submission?.id;

  const vote1 = await tool(aTok.access_token, "vote_mixtape", { submission_id: subBId });
  check("vote_mixtape A→B", vote1.data.status === "ok" && vote1.data.voted_for === subBId);

  const vote2 = await tool(bTok.access_token, "vote_mixtape", { submission_id: subBId });
  check("vote_mixtape B→B", vote2.data.status === "ok");

  const vote3 = await tool(cTok.access_token, "vote_mixtape", { submission_id: subAId });
  check("vote_mixtape C→A", vote3.data.status === "ok");

  const slot = await tool(cTok.access_token, "license_mixtape_slot", {
    text: "Paid slot on the shelf — I rent the tape, not the win itself.",
  });
  check("license_mixtape_slot stub", slot.data.status === "ok" && slot.data.settlement === "stubbed", slot.data.license?.id);
  check(
    "license_mixtape_slot split 20/80",
    slot.data.license?.house_cut_usd === 1 && slot.data.license?.seller_cut_usd === 4,
    JSON.stringify(slot.data.license)
  );
  check("license_mixtape_slot seller house", slot.data.license?.seller === "house");

  const got = await tool(aTok.access_token, "get_mixtape", { mixtape_id: mixtapeId });
  check("get_mixtape pre-publish", got.data.status === "ok" && got.data.mixtape?.status === "voting");
  check(
    "get_mixtape shows slot",
    Array.isArray(got.data.mixtape?.submissions) &&
      got.data.mixtape.submissions.some((s) => s.slot_paid === true),
    `n=${got.data.mixtape?.submissions?.length}`
  );

  const pub = await tool(aTok.access_token, "publish_mixtape", {
    mixtape_id: mixtapeId,
    beat_id: "boom-bap",
    price_usd: 2.0,
  });
  check("publish_mixtape", pub.data.status === "ok" && pub.data.mixtape?.status === "published");
  check(
    "publish paid slot first",
    pub.data.mixtape?.tracklist?.[0]?.slot_paid === true,
    JSON.stringify(pub.data.mixtape?.tracklist?.map((t) => ({ pos: t.position, slot: t.slot_paid, votes: t.vote_count })))
  );

  const earlyBuy = await tool(cTok.access_token, "buy_mixtape", { mixtape_id: mixtapeId });
  // C already has identity; buy should work after publish
  check("buy_mixtape stub", earlyBuy.data.status === "ok" && earlyBuy.data.settlement === "stubbed");
  check(
    "buy_mixtape split 20/80 on $2",
    earlyBuy.data.purchase?.house_cut_usd === 0.4 && earlyBuy.data.purchase?.seller_cut_usd === 1.6,
    JSON.stringify(earlyBuy.data.purchase)
  );
  check(
    "buy_mixtape artist splits",
    Array.isArray(earlyBuy.data.purchase?.artist_splits) && earlyBuy.data.purchase.artist_splits.length >= 1
  );

  const dup = await tool(cTok.access_token, "buy_mixtape", { mixtape_id: mixtapeId });
  check("buy_mixtape idempotent reject", !!dup.data.error && String(dup.data.error).includes("already"), dup.data.error);

  const listed = await tool(aTok.access_token, "list_mixtapes", { status: "published" });
  check(
    "list_mixtapes published",
    Array.isArray(listed.data.mixtapes) && listed.data.mixtapes.some((m) => m.id === mixtapeId)
  );

  const afterPub = await tool(aTok.access_token, "get_mixtape", { mixtape_id: mixtapeId });
  check(
    "get_mixtape tracklist",
    afterPub.data.mixtape?.status === "published" && Array.isArray(afterPub.data.mixtape?.tracklist)
  );

  // Guardrail reminder in responses
  check(
    "paid heat note present",
    String(earlyBuy.data.note || "").includes("Paid heat") || String(slot.data.note || "").includes("Paid heat")
  );

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${passed}/${results.length} assertions passed`);
  if (failed.length) {
    console.error("Failures:", failed);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
