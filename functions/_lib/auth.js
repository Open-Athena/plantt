// Sessions, the sign-in policy, and audit helpers shared by every Pages Function.
// Web Crypto only. Identity is the GitHub login. See docs/multiuser-plan.md.
export const SESSION_COOKIE = "plantt_s";
export const NONCE_COOKIE = "plantt_n";
export const SESSION_TTL_S = 30 * 24 * 3600;
// Org membership is verified at sign-in (it needs the user's GitHub token, which we never
// store) and cached on the user row. Past this age the session is treated as stale and the
// client offers sign-in again, which is instant if they are still in the org.
export const ORG_CACHE_MS = 7 * 24 * 3600 * 1000;
export const UA = "plantt (https://github.com/Open-Athena/plantt)";
export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const hmacKey = (secret) => crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

export function secret(env) {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is not set (wrangler pages secret put SESSION_SECRET, or .dev.vars)");
  return env.SESSION_SECRET;
}
// token = base64url(json) "." base64url(hmac). `exp` (ms) is enforced on verify.
export async function sign(payload, key) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = b64u(await crypto.subtle.sign("HMAC", await hmacKey(key), enc.encode(body)));
  return body + "." + sig;
}
export async function verify(token, key) {
  if (!token || typeof token !== "string") return null;
  const i = token.lastIndexOf(".");
  if (i < 0) return null;
  const body = token.slice(0, i), sig = token.slice(i + 1);
  try {
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(key), unb64u(sig), enc.encode(body)))) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64u(body)));
    if (p.exp && p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

// ── cookies ──
export function readCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
export const isSecure = (request) => new URL(request.url).protocol === "https:";
export function cookie(name, value, { maxAge, secure }) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
export const publicOrigin = (request, env) => env.PUBLIC_ORIGIN || new URL(request.url).origin;

// ── responses ──
export const json = (obj, status = 200, headers = {}) =>
  Response.json(obj, { status, headers: { "cache-control": "no-store", ...headers } });
export function redirect(location, cookies = []) {
  const h = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
}
export async function body(request) { try { return await request.json(); } catch { return {}; } }

// ── policy: who may be signed in, and as what ──
export const adminLogins = (env) => new Set((env.ADMIN_LOGINS || "").split(/[\s,]+/).filter(Boolean).map((s) => s.toLowerCase()));

// Admin list OR allowlist OR org member. Returns { allowed, role, via }.
export async function evaluatePolicy(env, login, orgMember, storedRole) {
  if (adminLogins(env).has(login.toLowerCase())) return { allowed: true, role: "admin", via: "admin" };
  const row = await env.DB.prepare("SELECT 1 AS ok FROM allowed_users WHERE lower(login) = lower(?1)").bind(login).first();
  const role = storedRole === "admin" ? "admin" : "member";
  if (row) return { allowed: true, role, via: "allowlist" };
  if (orgMember) return { allowed: true, role, via: "org" };
  return { allowed: false, role: null, via: null };
}

// Per-request authentication: a valid cookie is necessary, not sufficient — the policy is
// re-evaluated every time, so removing someone from the allowlist takes effect immediately.
export async function authenticate(ctx) {
  const { request, env } = ctx;
  const tok = readCookie(request, SESSION_COOKIE);
  if (!tok) return null;
  const p = await verify(tok, secret(env));
  if (!p || p.v !== 1 || !p.sub) return null;
  const u = await env.DB.prepare(
    "SELECT login, github_id, avatar_url, role, org_member, org_checked_at, last_seen_at FROM users WHERE login = ?1").bind(p.sub).first();
  if (!u) return null;
  const fresh = !!u.org_member && Date.now() - (u.org_checked_at || 0) < ORG_CACHE_MS;
  const d = await evaluatePolicy(env, u.login, fresh, u.role);
  if (!d.allowed) return null;
  if (Date.now() - (u.last_seen_at || 0) > 5 * 60 * 1000) {
    const upd = env.DB.prepare("UPDATE users SET last_seen_at = ?1 WHERE login = ?2").bind(Date.now(), u.login).run();
    if (ctx.waitUntil) ctx.waitUntil(upd); else await upd;
  }
  return { login: u.login, github_id: u.github_id, avatar: u.avatar_url, role: d.role, via: d.via };
}
export async function requireUser(ctx) {
  const u = await authenticate(ctx);
  if (!u) throw json({ error: "unauthenticated" }, 401);
  return u;
}
export async function requireAdmin(ctx) {
  const u = await requireUser(ctx);
  if (u.role !== "admin") throw json({ error: "forbidden" }, 403);
  return u;
}
// Wrap a handler so `throw json(...)` becomes the response and anything else is a clean 500.
export const handler = (fn) => async (ctx) => {
  try { return await fn(ctx); }
  catch (e) {
    if (e instanceof Response) return e;
    console.error(e && e.stack || e);
    return json({ error: String(e && e.message || e) }, 500);
  }
};

// ── audit ──
export async function ipHash(env, request) {
  const ip = request.headers.get("CF-Connecting-IP") || (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim();
  if (!ip) return null;
  return b64u(await crypto.subtle.sign("HMAC", await hmacKey(secret(env)), enc.encode("ip:" + ip))).slice(0, 22);
}
export async function logAuth(env, request, { login, event, detail }) {
  await env.DB.prepare("INSERT INTO auth_events (ts, login, event, detail, ip_hash, ua) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(Date.now(), login || null, event, detail || null, await ipHash(env, request), (request.headers.get("User-Agent") || "").slice(0, 200)).run();
}
export async function logPlan(env, request, { actor, planId, action, nodeHash, detail }) {
  await env.DB.prepare("INSERT INTO plan_events (ts, actor_login, plan_id, action, node_hash, detail_json, ip_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(Date.now(), actor || null, planId, action, nodeHash || null, detail ? JSON.stringify(detail) : null, await ipHash(env, request)).run();
}
