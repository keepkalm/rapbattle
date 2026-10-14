/**
 * Local E2E for Phase 1 beat marketplace MCP tools.
 * Requires: wrangler dev --local on :8787 with resourceMetadata temporarily off.
 *
 * Usage: node scripts/marketplace-e2e.mjs
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
      client_name: "marketplace-e2e",
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

  // parseAuthRequest runs on both GET and POST, so the authorize URL must keep
  // the OAuth query string on the consent POST (empty query → "client_id is required").
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
  const sellerTok = await authorizeAndToken(client);
  const buyerTok = await authorizeAndToken(client);

  const seller = await tool(sellerTok.access_token, "introduce_yourself", {
    name: "BeatSeller",
    intro: "I sell loops for the booth, dusty kicks with truth in the tooth.",
    provider: "house",
    voice_id: "luna",
  });
  check("seller introduce_yourself", seller.data.status === "ok", seller.data.agent?.id);

  const buyer = await tool(buyerTok.access_token, "introduce_yourself", {
    name: "BeatBuyer",
    intro: "I buy the bed and spit the lead, pay the cut and plant the seed.",
    provider: "house",
    voice_id: "orion",
  });
  check("buyer introduce_yourself", buyer.data.status === "ok", buyer.data.agent?.id);

  const created = await tool(sellerTok.access_token, "create_beat", {
    title: "Dust Pocket",
    audio_ref: "https://example.com/beats/dust-pocket-full.mp3",
    bpm: 88,
    feel: "lo-fi swing",
    description: "Seller production bed",
  });
  check("create_beat", created.data.status === "ok" && created.data.beat?.id, created.data.beat?.id);
  const beatId = created.data.beat?.id;
  check("create_beat hides listing", created.data.beat?.listed === false);
  check("create_beat sets house preview", !!created.data.beat?.preview_ref && created.data.beat.preview_ref.startsWith("house-preview"));

  const listed = await tool(sellerTok.access_token, "offer_beat", {
    beat_id: beatId,
    prices: { practice: 0.5, battle: 2.0, tape: 5.0, exclusive_24h: 10.0 },
  });
  check("offer_beat", listed.data.status === "ok" && listed.data.beat?.listed === true, JSON.stringify(listed.data.beat?.prices));

  const floor = await tool(sellerTok.access_token, "set_beat_price", {
    beat_id: beatId,
    license_type: "practice",
    price_usd: 0.1,
  });
  check("set_beat_price floor", !!floor.data.error && String(floor.data.error).includes("0.25"), floor.data.error);

  const priceOk = await tool(sellerTok.access_token, "set_beat_price", {
    beat_id: beatId,
    license_type: "practice",
    price_usd: 0.75,
  });
  check("set_beat_price ok", priceOk.data.status === "ok");

  const catalog = await tool(buyerTok.access_token, "list_beats", {});
  check("list_beats house", Array.isArray(catalog.data.house) && catalog.data.house.length >= 1);
  check(
    "list_beats marketplace",
    Array.isArray(catalog.data.marketplace) && catalog.data.marketplace.some((b) => b.id === beatId),
    `count=${catalog.data.marketplace?.length}`
  );
  const row = catalog.data.marketplace.find((b) => b.id === beatId);
  check("list_beats no audio_ref", row && !("audio_ref" in row));

  const preview = await tool(buyerTok.access_token, "preview_beat", { beat_id: beatId });
  check("preview_beat house demo", preview.data.status === "ok" && !!preview.data.preview?.id);
  check("preview_beat no audio_ref", !("audio_ref" in preview.data));

  const selfBuy = await tool(sellerTok.access_token, "license_beat", {
    beat_id: beatId,
    license_type: "battle",
  });
  check("seller cannot self-license", !!selfBuy.data.error, selfBuy.data.error);

  const buy = await tool(buyerTok.access_token, "buy_beat", {
    beat_id: beatId,
    license_type: "battle",
  });
  check("buy_beat stub", buy.data.status === "ok" && buy.data.settlement === "stubbed", buy.data.license?.id);
  check("buy_beat split 20/80", buy.data.license?.house_cut_usd === 0.4 && buy.data.license?.seller_cut_usd === 1.6, JSON.stringify(buy.data.license));
  check("buy_beat unlocks audio_ref", !!buy.data.license?.audio_ref);

  const sales = await tool(sellerTok.access_token, "get_beat_sales", { beat_id: beatId });
  check("get_beat_sales", sales.data.status === "ok" && sales.data.earnings?.sale_count === 1, JSON.stringify(sales.data.earnings));

  const earn = await tool(sellerTok.access_token, "my_beat_earnings", {});
  check(
    "my_beat_earnings",
    earn.data.status === "ok" && earn.data.earnings?.seller_usd === 1.6 && earn.data.earnings?.house_usd === 0.4,
    JSON.stringify(earn.data.earnings)
  );

  const exclusive = await tool(buyerTok.access_token, "license_beat", {
    beat_id: beatId,
    license_type: "exclusive_24h",
  });
  check("exclusive license", exclusive.data.status === "ok" && !!exclusive.data.license?.expires_at);

  // Second buyer should be blocked by exclusive.
  const buyer2Tok = await authorizeAndToken(client);
  await tool(buyer2Tok.access_token, "introduce_yourself", {
    name: "LateBuyer",
    intro: "Too late to the booth, exclusive took the truth.",
    provider: "house",
    voice_id: "athena",
  });
  const blocked = await tool(buyer2Tok.access_token, "license_beat", {
    beat_id: beatId,
    license_type: "battle",
  });
  check("exclusive blocks others", !!blocked.data.error && String(blocked.data.error).includes("exclusive"), blocked.data.error);

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
