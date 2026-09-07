// mcp.austindevs.com — multi-account proxy for remote MCP servers.
//
//   https://mcp.austindevs.com/<service>/<account>/mcp
//
// Toward Claude:  this Worker is an OAuth 2.1 authorization server (with DCR),
//                 courtesy of @cloudflare/workers-oauth-provider.
// Toward upstream: each grant holds its own upstream token (Slack / Sentry /
//                 Trello), obtained via the upstream's own OAuth flow at consent
//                 time. The <account> segment is a label that makes each connector
//                 URL unique so claude.ai keeps a separate token per account.

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

const SERVICES = {
  slack:  { url: "https://mcp.slack.com/mcp",  name: "Slack" },
  sentry: { url: "https://mcp.sentry.dev/mcp", name: "Sentry" },
  trello: { url: "https://mcp.trello.com/v1",  name: "Trello" },
};

const FLOW_TTL = 600;          // seconds a pending /authorize -> /callback flow may live
const REFRESH_SKEW = 120;      // refresh upstream token this many seconds before expiry
const FWD_REQ_HEADERS = ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
const FWD_RES_HEADERS = ["content-type", "mcp-session-id", "mcp-protocol-version", "cache-control"];

// ---------- helpers ----------

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json", ...headers } });

const html = (body, status = 200) =>
  new Response(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>mcp.austindevs.com</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 20px;color:#222}
code,pre{background:#f3f3f3;border-radius:4px;padding:2px 5px}pre{padding:12px;overflow:auto}
label{display:block;margin:12px 0 4px}input,select{font:inherit;padding:6px 8px;width:100%;max-width:320px}
button{font:inherit;padding:8px 16px;margin-top:16px}h1{font-size:22px}</style>
${body}`, { status, headers: { "content-type": "text/html; charset=utf-8" } });

const rand = (n = 32) => {
  const b = new Uint8Array(n); crypto.getRandomValues(b);
  return b64url(b);
};
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha256 = async (s) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));

// Parse "/<service>/<account>/mcp" -> { service, account } or null
function parsePath(pathname) {
  const m = pathname.match(/^\/(slack|sentry|trello)\/([a-z0-9][a-z0-9-]{0,63})\/mcp\/?$/i);
  return m ? { service: m[1].toLowerCase(), account: m[2].toLowerCase() } : null;
}

// Per-account config wins over per-service: SLACK_ZOLLEGE_CLIENT_ID, then SLACK_CLIENT_ID.
const envKey = (s) => s.toUpperCase().replace(/-/g, "_");
const cfg = (env, service, key, account) =>
  (account && env[`${envKey(service)}_${envKey(account)}_${key}`]) || env[`${envKey(service)}_${key}`];

// Slack app client IDs look like "1234567890.1234567890". When claude.ai is configured with
// "Use your own OAuth client", it presents that ID (and secret) to *us*; we pass them straight
// through to Slack instead of needing Worker vars.
const isSlackAppId = (id) => /^\d{6,}\.\d{6,}$/.test(id || "");

// Register an unknown BYO client ID with the OAuth provider so parseAuthRequest accepts it.
async function ensurePassthroughClient(env, clientId, redirectUri) {
  const key = `client:${clientId}`;
  const existing = await env.OAUTH_KV.get(key, "json");
  if (existing) {
    if (!existing.redirectUris.includes(redirectUri)) { existing.redirectUris.push(redirectUri); await env.OAUTH_KV.put(key, JSON.stringify(existing)); }
    return existing;
  }
  const info = {
    clientId, redirectUris: [redirectUri], clientName: "claude.ai (BYO client)",
    grantTypes: ["authorization_code", "refresh_token"], responseTypes: ["code"],
    registrationDate: Math.floor(Date.now() / 1000),
    tokenEndpointAuthMethod: "client_secret_post", authMethodExplicit: true, passthrough: true,
  };
  await env.OAUTH_KV.put(key, JSON.stringify(info));
  return info;
}

// ---------- upstream OAuth discovery (RFC 9728 + RFC 8414) ----------

async function discover(service) {
  const { url } = SERVICES[service];
  // Probe upstream for the resource_metadata pointer.
  let prmUrl;
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    const wa = r.headers.get("www-authenticate") || "";
    prmUrl = /resource_metadata="([^"]+)"/.exec(wa)?.[1];
  } catch {}
  if (!prmUrl) { const u = new URL(url); prmUrl = `${u.origin}/.well-known/oauth-protected-resource${u.pathname === "/" ? "" : u.pathname}`; }
  const prm = await (await fetch(prmUrl)).json();
  const as = prm.authorization_servers?.[0];
  if (!as) throw new Error(`No authorization server advertised for ${service}`);
  const asu = new URL(as);
  const candidates = [
    `${asu.origin}/.well-known/oauth-authorization-server${asu.pathname === "/" ? "" : asu.pathname}`,
    `${asu.origin}/.well-known/openid-configuration${asu.pathname === "/" ? "" : asu.pathname}`,
    `${as.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
  ];
  let meta;
  for (const c of candidates) { try { const r = await fetch(c); if (r.ok) { meta = await r.json(); break; } } catch {} }
  if (!meta?.authorization_endpoint || !meta?.token_endpoint) throw new Error(`Could not discover authorization server metadata for ${service}`);
  return { resource: prm.resource || url, scopes: prm.scopes_supported || meta.scopes_supported || [], meta };
}

// Get an upstream OAuth client: configured (env) or dynamically registered (cached in KV).
async function upstreamClient(env, service, account, meta, callback, passthroughId) {
  if (passthroughId) return { client_id: passthroughId, source: "passthrough" };
  const id = cfg(env, service, "CLIENT_ID", account);
  if (id) return { client_id: id, client_secret: cfg(env, service, "CLIENT_SECRET", account) || undefined, source: "env" };
  const key = `upclient:${service}:${callback}`;
  const cached = await env.OAUTH_KV.get(key, "json");
  if (cached) return cached;
  if (!meta.registration_endpoint) throw new Error(`${SERVICES[service].name} does not support dynamic client registration; set ${envKey(service)}_${envKey(account)}_CLIENT_ID and _CLIENT_SECRET (or the ${envKey(service)}_ defaults) on the Worker.`);
  const r = await fetch(meta.registration_endpoint, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: `mcp.austindevs.com (${service})`, redirect_uris: [callback],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const reg = await r.json();
  if (!r.ok || !reg.client_id) throw new Error(`DCR failed for ${service}: ${JSON.stringify(reg).slice(0, 300)}`);
  const client = { client_id: reg.client_id, client_secret: reg.client_secret, source: "dcr" };
  await env.OAUTH_KV.put(key, JSON.stringify(client));
  return client;
}

async function tokenRequest(tok, params) {
  const body = new URLSearchParams({ ...params, client_id: tok.client_id });
  if (tok.client_secret) body.set("client_secret", tok.client_secret);
  const r = await fetch(tok.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false || data.error) throw new Error(`Token request failed (${r.status}): ${JSON.stringify(data).slice(0, 300)}`);
  // Slack's user-token endpoint may nest the token under authed_user.
  const src = data.access_token ? data : (data.authed_user?.access_token ? data.authed_user : null);
  if (!src) throw new Error(`Token response had no access_token: ${JSON.stringify(data).slice(0, 300)}`);
  return {
    access_token: src.access_token,
    refresh_token: src.refresh_token || tok.refresh_token,
    expires_at: src.expires_in ? Math.floor(Date.now() / 1000) + Number(src.expires_in) : undefined,
  };
}

// ---------- /authorize, /callback, landing ----------

async function handleAuthorize(request, env) {
  const url = new URL(request.url);
  const rawClientId = url.searchParams.get("client_id") || "";
  const known = isSlackAppId(rawClientId) ? await env.OAUTH_KV.get(`client:${rawClientId}`, "json") : null;
  const passthrough = isSlackAppId(rawClientId) && (!known || known.passthrough === true);
  if (passthrough) await ensurePassthroughClient(env, rawClientId, url.searchParams.get("redirect_uri") || "");
  let authReq;
  try { authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request); }
  catch (e) { return html(`<h1>Authorization error</h1><p>${escape(e.message)}</p>`, 400); }

  // Figure out which service/account this connector is for: the RFC 8707 resource parameter
  // (claude.ai sends it), or an explicit ?target= from our own picker form.
  let target = parsePath(new URL(url.searchParams.get("target") || (Array.isArray(authReq.resource) ? authReq.resource[0] : authReq.resource) || "http://x/").pathname);
  if (!target) {
    const qs = new URLSearchParams(url.search); qs.delete("target");
    const opts = Object.entries(SERVICES).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join("");
    return html(`<h1>Which connector is this for?</h1>
<p>The client didn't say which resource it wants a token for. Pick the service and account label that matches the connector URL you added in Claude.</p>
<form method=get action="/authorize"><input type=hidden name=q value="${escape(qs.toString())}">
<label>Service</label><select name=svc>${opts}</select>
<label>Account label</label><input name=acct placeholder="zollege" pattern="[a-z0-9][a-z0-9-]{0,63}" required>
<button>Continue</button></form>
<script>document.forms[0].onsubmit=e=>{e.preventDefault();const f=e.target;location='/authorize?'+f.q.value+'&target='+encodeURIComponent(location.origin+'/'+f.svc.value+'/'+f.acct.value+'/mcp')}</script>`);
  }

  const { service, account } = target;
  const callback = `${url.origin}/callback`;
  let disc, client;
  try {
    disc = await discover(service);
    client = await upstreamClient(env, service, account, disc.meta, callback, passthrough ? rawClientId : null);
  } catch (e) { return html(`<h1>Upstream setup failed</h1><p>${escape(e.message)}</p>`, 502); }

  const state = rand(24);
  const verifier = rand(48);
  const scopes = (cfg(env, service, "SCOPES", account) || disc.scopes.join(" ")).trim();

  await env.OAUTH_KV.put(`st:${state}`, JSON.stringify({
    authReq, service, account, verifier, callback, passthrough: client.source === "passthrough",
    token_endpoint: disc.meta.token_endpoint, client_id: client.client_id, client_secret: client.client_secret,
    resource: disc.resource, scopes,
  }), { expirationTtl: FLOW_TTL });

  const a = new URL(disc.meta.authorization_endpoint);
  a.searchParams.set("response_type", "code");
  a.searchParams.set("client_id", client.client_id);
  a.searchParams.set("redirect_uri", callback);
  a.searchParams.set("state", state);
  a.searchParams.set("code_challenge", await sha256(verifier));
  a.searchParams.set("code_challenge_method", "S256");
  a.searchParams.set("resource", disc.resource);
  if (scopes) a.searchParams.set("scope", scopes);
  return Response.redirect(a.toString(), 302);
}

async function handleCallback(request, env) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const flow = state && await env.OAUTH_KV.get(`st:${state}`, "json");
  if (!flow) return html(`<h1>Login session expired</h1><p>Start the connection again from Claude.</p>`, 400);
  await env.OAUTH_KV.delete(`st:${state}`);
  if (url.searchParams.get("error")) return html(`<h1>${escape(flow.service)} denied the request</h1><p>${escape(url.searchParams.get("error_description") || url.searchParams.get("error"))}</p>`, 400);

  const sid = rand(24);
  const upstreamCode = url.searchParams.get("code");
  if (!flow.passthrough) {
    // We hold the upstream client credentials: exchange the code now.
    let tokens;
    try {
      tokens = await tokenRequest(flow, { grant_type: "authorization_code", code: upstreamCode, redirect_uri: flow.callback, code_verifier: flow.verifier, resource: flow.resource });
    } catch (e) { return html(`<h1>Token exchange failed</h1><p>${escape(e.message)}</p>`, 502); }
    await env.OAUTH_KV.put(`up:${sid}`, JSON.stringify({
      ...tokens, token_endpoint: flow.token_endpoint, client_id: flow.client_id, client_secret: flow.client_secret,
      resource: flow.resource, service: flow.service, account: flow.account, created_at: Math.floor(Date.now() / 1000),
    }));
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: flow.authReq,
    userId: `${flow.service}--${flow.account}`,
    scope: flow.authReq.scope,
    metadata: { service: flow.service, account: flow.account },
    props: { sid, service: flow.service, account: flow.account },
  });

  if (flow.passthrough) {
    // The client secret only arrives with Claude's /token call, so park the upstream code
    // against our grant id (embedded in the auth code we just minted) until then.
    const grantId = (new URL(redirectTo).searchParams.get("code") || "").split(":")[1];
    await env.OAUTH_KV.put(`pend:${grantId}`, JSON.stringify({
      sid, code: upstreamCode, verifier: flow.verifier, callback: flow.callback, token_endpoint: flow.token_endpoint,
      client_id: flow.client_id, resource: flow.resource, service: flow.service, account: flow.account,
    }), { expirationTtl: FLOW_TTL });
  }
  return Response.redirect(redirectTo, 302);
}

// /token interception for pass-through clients: verify the secret against the upstream by doing
// the deferred code exchange, then hand the request on to the OAuth provider.
async function interceptToken(request, env) {
  const form = await request.clone().formData().catch(() => null);
  if (!form) return null;
  const clientId = form.get("client_id"), secret = form.get("client_secret");
  if (!clientId || !secret || !isSlackAppId(clientId)) return null;
  const client = await env.OAUTH_KV.get(`client:${clientId}`, "json");
  if (!client?.passthrough) return null;

  if (form.get("grant_type") === "authorization_code") {
    const grantId = (form.get("code") || "").split(":")[1];
    const pend = grantId && await env.OAUTH_KV.get(`pend:${grantId}`, "json");
    if (!pend) return json({ error: "invalid_grant", error_description: "Pending upstream authorization not found or expired; reconnect" }, 400);
    let tokens;
    try {
      tokens = await tokenRequest({ ...pend, client_secret: secret }, { grant_type: "authorization_code", code: pend.code, redirect_uri: pend.callback, code_verifier: pend.verifier, resource: pend.resource });
    } catch (e) {
      return json({ error: "invalid_client", error_description: `${SERVICES[pend.service].name} rejected the client credentials: ${e.message}` }, 401);
    }
    await env.OAUTH_KV.delete(`pend:${grantId}`);
    await env.OAUTH_KV.put(`up:${pend.sid}`, JSON.stringify({
      ...tokens, token_endpoint: pend.token_endpoint, client_id: pend.client_id, client_secret: secret,
      resource: pend.resource, service: pend.service, account: pend.account, created_at: Math.floor(Date.now() / 1000),
    }));
    // Upstream accepted the secret, so record it (hashed) for the provider's own client auth.
    if (!client.clientSecret) { client.clientSecret = await hashHex(secret); await env.OAUTH_KV.put(`client:${clientId}`, JSON.stringify(client)); }
  }
  return null; // fall through to the provider with the original request
}

const hashHex = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");

function landing(request) {
  const origin = new URL(request.url).origin;
  const rows = Object.entries(SERVICES).map(([k, v]) => `<tr><td>${v.name}</td><td><code>${origin}/${k}/&lt;account&gt;/mcp</code></td></tr>`).join("");
  return html(`<h1>mcp.austindevs.com</h1>
<p>Multi-account front door for remote MCP servers. Add one custom connector in Claude per account, using a URL of the form:</p>
<table>${rows}</table>
<p><code>&lt;account&gt;</code> is any label (<code>zollege</code>, <code>paycove</code>, …). It only needs to be unique per service; you choose the actual workspace/org on the upstream login screen.</p>`);
}

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- authenticated API proxy ----------

const apiHandler = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const target = parsePath(url.pathname);
    const props = ctx.props || {};
    if (!target) return json({ error: "not_found" }, 404);
    if (props.service !== target.service || props.account !== target.account)
      return json({ error: "forbidden", error_description: `This token was issued for /${props.service}/${props.account}/mcp` }, 403);

    const key = `up:${props.sid}`;
    let up = await env.OAUTH_KV.get(key, "json");
    if (!up) return unauthorized(url, "invalid_token", "Upstream credentials missing; reconnect this connector");

    const now = Math.floor(Date.now() / 1000);
    if (up.refresh_token && up.expires_at && up.expires_at - REFRESH_SKEW < now) {
      up = await refresh(env, key, up).catch(() => up);
    }

    // Buffer the body once so we can retry after a token refresh.
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    let res = await forward(request, up, body);
    if (res.status === 401 && up.refresh_token) {
      try { up = await refresh(env, key, up); res = await forward(request, up, body); } catch {}
    }
    if (res.status === 401) return unauthorized(url, "invalid_token", `${SERVICES[target.service].name} rejected the upstream token; reconnect this connector`);

    const headers = new Headers();
    for (const h of FWD_RES_HEADERS) { const v = res.headers.get(h); if (v) headers.set(h, v); }
    return new Response(res.body, { status: res.status, headers });
  },
};

function forward(request, up, body) {
  const headers = new Headers();
  for (const h of FWD_REQ_HEADERS) { const v = request.headers.get(h); if (v) headers.set(h, v); }
  headers.set("authorization", `Bearer ${up.access_token}`);
  return fetch(SERVICES[up.service].url, { method: request.method, headers, body });
}

async function refresh(env, key, up) {
  const t = await tokenRequest(up, { grant_type: "refresh_token", refresh_token: up.refresh_token, resource: up.resource });
  const next = { ...up, ...t, refreshed_at: Math.floor(Date.now() / 1000) };
  await env.OAUTH_KV.put(key, JSON.stringify(next));
  return next;
}

function unauthorized(url, error, description) {
  return json({ error, error_description: description }, 401, {
    "www-authenticate": `Bearer realm="OAuth", error="${error}", error_description="${description}", resource_metadata="${url.origin}/.well-known/oauth-protected-resource${url.pathname}"`,
  });
}

// ---------- default (unauthenticated) routes ----------

const defaultHandler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/authorize") return handleAuthorize(request, env);
    if (url.pathname === "/callback") return handleCallback(request, env);
    if (url.pathname === "/healthz") return json({ ok: true });
    if (url.pathname === "/" || url.pathname === "") return landing(request);
    return json({ error: "not_found", hint: "Use /<service>/<account>/mcp" }, 404);
  },
};

const provider = new OAuthProvider({
  apiRoute: ["/slack/", "/sentry/", "/trello/"],
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  accessTokenTTL: 3600,
});

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/token" && request.method === "POST") {
      const early = await interceptToken(request, env);
      if (early) return early;
    }
    return provider.fetch(request, env, ctx);
  },
};
