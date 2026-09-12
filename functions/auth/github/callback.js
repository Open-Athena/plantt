// Finish GitHub sign-in: check state + nonce, trade the code for a token, read the profile
// and org membership, apply the policy, mint the session cookie.
import {
  NONCE_COOKIE, SESSION_COOKIE, SESSION_TTL_S, UA, cookie, evaluatePolicy, isSecure,
  logAuth, publicOrigin, readCookie, redirect, secret, sign, verify,
} from "../../_lib/auth.js";

const fail = (why) => new Response("sign-in failed: " + why + "\n", { status: 400, headers: { "cache-control": "no-store" } });

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const secure = isSecure(request);
  const clearNonce = cookie(NONCE_COOKIE, "", { maxAge: 0, secure });
  if (url.searchParams.get("error")) return redirect("/?denied=" + encodeURIComponent(url.searchParams.get("error")), [clearNonce]);

  const code = url.searchParams.get("code");
  const state = code ? await verify(url.searchParams.get("state"), secret(env)) : null;
  if (!state || state.t !== "oauth") return fail("bad or expired state");
  const nonce = readCookie(request, NONCE_COOKIE);
  if (!nonce || nonce !== state.n) return fail("state was not issued to this browser");

  const tok = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code,
      redirect_uri: publicOrigin(request, env) + "/auth/github/callback",
    }),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!tok || !tok.access_token) return fail("token exchange failed" + (tok && tok.error ? " (" + tok.error + ")" : ""));

  const gh = (path) => fetch("https://api.github.com" + path, {
    headers: { authorization: "Bearer " + tok.access_token, accept: "application/vnd.github+json", "user-agent": UA, "x-github-api-version": "2022-11-28" },
  });
  const me = await gh("/user").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!me || !me.login) return fail("could not read the GitHub profile");
  const login = me.login;

  // Org membership. Three routes because OAuth-app and GitHub-app user tokens see different
  // endpoints; the first that says yes wins, and the route is recorded for debugging.
  const org = env.GITHUB_ORG || "Open-Athena";
  let orgMember = false, how = "";
  try {
    const m = await gh(`/user/memberships/orgs/${org}`);
    if (m.status === 200) { const j = await m.json(); if (j.state === "active") { orgMember = true; how = "memberships"; } }
    if (!orgMember && (await gh(`/orgs/${org}/members/${login}`)).status === 204) { orgMember = true; how = "members"; }
    if (!orgMember) {
      const r = await gh("/user/orgs?per_page=100");
      if (r.ok && (await r.json()).some((o) => String(o.login).toLowerCase() === org.toLowerCase())) { orgMember = true; how = "user/orgs"; }
    }
  } catch { /* treated as not a member; the allowlist still applies */ }

  const now = Date.now();
  const existing = await env.DB.prepare("SELECT role FROM users WHERE login = ?1").bind(login).first();
  await env.DB.prepare(`
    INSERT INTO users (login, github_id, avatar_url, role, first_seen_at, last_seen_at, org_member, org_checked_at)
    VALUES (?1, ?2, ?3, 'member', ?4, ?4, ?5, ?4)
    ON CONFLICT(login) DO UPDATE SET github_id = excluded.github_id, avatar_url = excluded.avatar_url,
      last_seen_at = excluded.last_seen_at, org_member = excluded.org_member, org_checked_at = excluded.org_checked_at`)
    .bind(login, me.id, me.avatar_url || null, now, orgMember ? 1 : 0).run();

  const d = await evaluatePolicy(env, login, orgMember, existing && existing.role);
  if (!d.allowed) {
    await logAuth(env, request, { login, event: "deny", detail: `not allowed (org member: ${orgMember})` });
    return redirect("/?denied=" + encodeURIComponent(login), [clearNonce]);
  }
  const session = await sign({ v: 1, sub: login, exp: now + SESSION_TTL_S * 1000 }, secret(env));
  await logAuth(env, request, { login, event: "signin", detail: d.via + (how ? " via " + how : "") });
  return redirect(state.next || "/", [cookie(SESSION_COOKIE, session, { maxAge: SESSION_TTL_S, secure }), clearNonce]);
}
