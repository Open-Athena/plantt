// Admin console API: users + roles, the allowlist, and the audit log. Admins only.
import { LOGIN_RE, adminLogins, body, handler, json, logAuth, requireAdmin } from "../../_lib/auth.js";

async function listing(env) {
  const users = (await env.DB.prepare(
    "SELECT login, avatar_url, role, org_member, org_checked_at, first_seen_at, last_seen_at FROM users ORDER BY last_seen_at DESC").all()).results;
  const allowed = (await env.DB.prepare("SELECT login, added_by, added_at, note FROM allowed_users ORDER BY added_at DESC").all()).results;
  return { users, allowed, envAdmins: [...adminLogins(env)], org: env.GITHUB_ORG || "Open-Athena" };
}

export const onRequest = handler(async (ctx) => {
  const { request, env, params } = ctx;
  const admin = await requireAdmin(ctx);
  const seg = params.path || [];
  const m = request.method;

  if (seg[0] === "users" && seg.length === 1 && m === "GET") return json(await listing(env));

  if (seg[0] === "allow" && seg.length === 1 && m === "POST") {
    const b = await body(request);
    const login = String(b.login || "").trim().replace(/^@/, "");
    if (!LOGIN_RE.test(login)) return json({ error: "not a valid GitHub login" }, 400);
    await env.DB.prepare("INSERT OR IGNORE INTO allowed_users (login, added_by, added_at, note) VALUES (?1, ?2, ?3, ?4)")
      .bind(login, admin.login, Date.now(), b.note ? String(b.note).slice(0, 200) : null).run();
    await logAuth(env, request, { login: admin.login, event: "allow_add", detail: login });
    return json(await listing(env));
  }
  if (seg[0] === "allow" && seg.length === 2 && m === "DELETE") {
    await env.DB.prepare("DELETE FROM allowed_users WHERE lower(login) = lower(?1)").bind(seg[1]).run();
    await logAuth(env, request, { login: admin.login, event: "allow_remove", detail: seg[1] });
    return json(await listing(env));
  }
  if (seg[0] === "users" && seg.length === 2 && m === "PATCH") {
    const b = await body(request);
    if (b.role !== "admin" && b.role !== "member") return json({ error: "role must be admin or member" }, 400);
    if (adminLogins(env).has(seg[1].toLowerCase()) && b.role !== "admin") return json({ error: "that admin is fixed by ADMIN_LOGINS" }, 400);
    await env.DB.prepare("UPDATE users SET role = ?1 WHERE login = ?2").bind(b.role, seg[1]).run();
    await logAuth(env, request, { login: admin.login, event: "role_change", detail: `${seg[1]} → ${b.role}` });
    return json(await listing(env));
  }
  if (seg[0] === "audit" && m === "GET") {
    const q = new URL(request.url).searchParams;
    const limit = Math.min(1000, Math.max(1, parseInt(q.get("limit") || "300", 10) || 300));
    const since = parseInt(q.get("since") || "0", 10) || 0;
    const auth = (await env.DB.prepare("SELECT ts, login, event, detail, ip_hash FROM auth_events WHERE ts > ?1 ORDER BY ts DESC LIMIT ?2").bind(since, limit).all()).results;
    const plans = (await env.DB.prepare(
      "SELECT e.ts, e.actor_login, e.plan_id, e.action, e.node_hash, e.detail_json, e.ip_hash, p.name AS plan_name FROM plan_events e LEFT JOIN plans p ON p.id = e.plan_id WHERE e.ts > ?1 ORDER BY e.ts DESC LIMIT ?2")
      .bind(since, limit).all()).results;
    return json({ auth, plans });
  }
  return json({ error: "not found" }, 404);
});
