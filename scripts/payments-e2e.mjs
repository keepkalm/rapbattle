/**
 * Local E2E for Phase 2 payment intents (dual-rail beside stub).
 * Requires: wrangler dev --local on :8787
 *
 * Usage: node scripts/payments-e2e.mjs
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
      client_name: "payments-e2e",
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

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond, detail });
  if (!cond) console.error("FAIL", name, detail);
  else console.log("ok  ", name, detail);
}

async function main() {
  const health = await fetch(`${ORIGIN}/health`);
  check("health", health.ok, String(health.status));

  const client = await registerClient();
  const sellerTok = await authorizeAndToken(client);
  const buyerTok = await authorizeAndToken(client);

  const seller = await tool(sellerTok.access_token, "introduce_yourself", {
    name: `PaySeller${crypto.randomUUID().slice(0, 6)}`,
    intro: "I list the bed so the booth gets fed, stub or intent both get read.",
    provider: "house",
    voice_id: "luna",
  });
  check("seller intro", seller.data.status === "ok", seller.data.agent?.id);

  const buyer = await tool(buyerTok.access_token, "introduce_yourself", {
    name: `PayBuyer${crypto.randomUUID().slice(0, 6)}`,
    intro: "I pay the cut with intent in the gut, confirm the rail then unlock the loot.",
    provider: "house",
    voice_id: "orion",
  });
  check("buyer intro", buyer.data.status === "ok", buyer.data.agent?.id);

  const created = await tool(sellerTok.access_token, "create_beat", {
    title: "Intent Pocket",
    audio_ref: "https://example.com/beats/intent-pocket.mp3",
    bpm: 92,
    feel: "intent swing",
  });
  const beatId = created.data.beat?.id;
  check("create_beat", !!beatId, beatId);

  const listed = await tool(sellerTok.access_token, "offer_beat", {
    beat_id: beatId,
    prices: { battle: 2.0, practice: 0.5 },
  });
  check("offer_beat", listed.data.status === "ok");

  // Bare stub path still works (do not break Phase 1 contracts).
  const stubBuy = await tool(buyerTok.access_token, "license_beat", {
    beat_id: beatId,
    license_type: "practice",
  });
  check(
    "stub license_beat unchanged",
    stubBuy.data.status === "ok" && stubBuy.data.settlement === "stubbed",
    stubBuy.data.license?.id
  );

  // Intent path: stub rail create → confirm → fulfill
  const intent = await tool(buyerTok.access_token, "create_payment_intent", {
    sku: "license_beat",
    beat_id: beatId,
    license_type: "battle",
    settlement_rail: "stubbed",
  });
  check(
    "create_payment_intent stub",
    intent.data.status === "ok" && intent.data.intent?.status === "pending",
    intent.data.intent?.intent_id
  );
  const intentId = intent.data.intent?.intent_id;
  check("intent memo", String(intent.data.intent?.memo || "").includes(intentId), intent.data.intent?.memo);

  const reused = await tool(buyerTok.access_token, "create_payment_intent", {
    sku: "license_beat",
    beat_id: beatId,
    license_type: "battle",
    settlement_rail: "stubbed",
  });
  check("intent idempotent", reused.data.reused === true && reused.data.intent?.intent_id === intentId);

  const got = await tool(buyerTok.access_token, "get_payment_intent", { intent_id: intentId });
  check("get_payment_intent", got.data.status === "ok" && got.data.intent?.intent_id === intentId);

  const confirmed = await tool(buyerTok.access_token, "confirm_payment", {
    intent_id: intentId,
    fulfill: true,
  });
  check(
    "confirm_payment fulfills stub",
    confirmed.data.status === "ok" &&
      confirmed.data.settlement === "stubbed" &&
      !!confirmed.data.license?.id &&
      confirmed.data.payment_intent_id === intentId,
    confirmed.data.license?.id
  );

  // X Money thin hook (no live send): create p2p intent, require external_ref, then fulfill
  const p2p = await tool(buyerTok.access_token, "create_payment_intent", {
    sku: "license_beat",
    beat_id: beatId,
    license_type: "battle",
    settlement_rail: "x_money_p2p",
  });
  // practice already bought; battle may already be licensed from confirm — exclusive not set,
  // so a second battle license is allowed (no exclusivity). Quote should still succeed.
  check(
    "x_money_p2p intent",
    p2p.data.status === "ok" &&
      p2p.data.intent?.settlement_rail === "x_money_p2p" &&
      !!p2p.data.x_money_p2p_hook?.memo &&
      !!p2p.data.x_money_p2p_hook?.payee_handle,
    JSON.stringify(p2p.data.x_money_p2p_hook)
  );
  const p2pId = p2p.data.intent?.intent_id;

  const needRef = await tool(buyerTok.access_token, "confirm_payment", {
    intent_id: p2pId,
    fulfill: true,
  });
  check("p2p needs external_ref", !!needRef.data.error && String(needRef.data.error).includes("external_ref"), needRef.data.error);

  const p2pOk = await tool(buyerTok.access_token, "confirm_payment", {
    intent_id: p2pId,
    external_ref: "xmoney-tx-e2e-1",
    fulfill: true,
  });
  check(
    "p2p confirm settles",
    p2pOk.data.status === "ok" && p2pOk.data.settlement === "x_money_p2p",
    p2pOk.data.settlement
  );

  // Mixtape intent stub path
  const published = await tool(sellerTok.access_token, "publish_mixtape", {
    title: "Intent Tape",
    price_usd: 1.0,
  });
  // May fail if no submissions — seed a freeform first
  if (published.data.error) {
    await tool(sellerTok.access_token, "submit_to_mixtape", {
      text: "Seed bars for the tape so publish can bake.",
    });
    const pub2 = await tool(sellerTok.access_token, "publish_mixtape", {
      title: "Intent Tape",
      price_usd: 1.0,
    });
    check("publish_mixtape", pub2.data.status === "ok", pub2.data.mixtape?.id);
  } else {
    check("publish_mixtape", published.data.status === "ok", published.data.mixtape?.id);
  }

  const tapeIntent = await tool(buyerTok.access_token, "create_payment_intent", {
    sku: "buy_mixtape",
    settlement_rail: "stubbed",
  });
  check("buy_mixtape intent", tapeIntent.data.status === "ok", tapeIntent.data.intent?.intent_id);

  const tapeBuy = await tool(buyerTok.access_token, "confirm_payment", {
    intent_id: tapeIntent.data.intent?.intent_id,
  });
  check(
    "buy_mixtape via confirm",
    tapeBuy.data.status === "ok" && tapeBuy.data.settlement === "stubbed",
    tapeBuy.data.purchase?.id
  );

  // Bare mixtape stub still works for a second buyer
  const buyer2Tok = await authorizeAndToken(client);
  await tool(buyer2Tok.access_token, "introduce_yourself", {
    name: `PayBuyer2${crypto.randomUUID().slice(0, 6)}`,
    intro: "Second buyer stubs the tape without an intent shape.",
    provider: "house",
    voice_id: "athena",
  });
  const bareTape = await tool(buyer2Tok.access_token, "buy_mixtape", {});
  check("bare buy_mixtape stub", bareTape.data.status === "ok" && bareTape.data.settlement === "stubbed");

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
