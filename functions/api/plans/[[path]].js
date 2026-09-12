// Plans API: index, create, meta/sharing, fork, archive/delete, the history tree (nodes +
// snapshots), head moves, ACL, per-plan audit. Every write is logged to plan_events.
import { LOGIN_RE, authenticate, body, handler, ipHash, json, logPlan, requireUser } from "../../_lib/auth.js";
import { EDIT_MODE, HASH_RE, PLAN_COLS, UUID_RE, VISIBILITY, atLeast, getPlan, levelFor, publicMeta, requireLevel, searchTextOf, setHead, sha256Hex } from "../../_lib/plans.js";
import { validate } from "../../../src/schema.js";

const RANK_VIS = { private: 0, org: 1, public: 2 };
const RANK_EDIT = { owner: 0, org: 1, public: 2 };
const actorOf = (u) => (u ? u.login : null);

export const onRequest = handler(async (ctx) => {
  const { request, env, params } = ctx;
  const seg = params.path || [];
  const m = request.method;
  const user = await authenticate(ctx);            // null = anonymous (allowed for public plans)

  // ── index / create ──
  if (seg.length === 0 && m === "GET") return json(await listPlans(env, await requireUser(ctx), new URL(request.url).searchParams));
  if (seg.length === 0 && m === "POST") return createPlan(ctx, await requireUser(ctx));

  const id = seg[0];
  if (!UUID_RE.test(id)) return json({ error: "bad plan id" }, 400);
  const sub = seg[1];

  if (!sub && m === "GET") {
    const { plan, level } = await requireLevel(env, id, user, "view");
    const extra = {};
    if (level === "manage") extra.acl = (await env.DB.prepare("SELECT login, level, granted_by, granted_at FROM plan_acl WHERE plan_id = ?1 ORDER BY granted_at").bind(id).all()).results;
    extra.forkedFromMeta = await forkSource(env, plan, user);
    return json(publicMeta(plan, level, extra));
  }
  if (!sub && m === "PATCH") return patchPlan(ctx, user, id);
  if (!sub && m === "DELETE") return deletePlan(ctx, user, id);
  if (sub === "fork" && m === "POST") return forkPlan(ctx, await requireUser(ctx), id);
  if (sub === "tree" && m === "GET") return getTree(ctx, user, id);
  if (sub === "nodes" && m === "GET") return getNodes(ctx, user, id);
  if (sub === "nodes" && m === "POST") return postNodes(ctx, user, id);
  if (sub === "head" && m === "GET") {
    const { plan } = await requireLevel(env, id, user, "view");
    return json({ head: plan.head_hash, updatedAt: plan.updated_at, lastEditBy: plan.last_edit_by });
  }
  if (sub === "head" && m === "POST") return postHead(ctx, user, id);
  if (sub === "acl") return acl(ctx, user, id, seg[2]);
  if (sub === "events" && m === "GET") {
    await requireLevel(env, id, user, "manage");
    const rows = (await env.DB.prepare("SELECT ts, actor_login, action, node_hash, detail_json FROM plan_events WHERE plan_id = ?1 ORDER BY ts DESC LIMIT 500").bind(id).all()).results;
    return json({ events: rows });
  }
  return json({ error: "not found" }, 404);
});

// ── index ──
async function listPlans(env, user, q) {
  const filter = q.get("filter") || "all";          // all | mine | shared | org | archived
  const text = (q.get("q") || "").trim().toLowerCase();
  const rows = (await env.DB.prepare(`
    SELECT ${PLAN_COLS}, u.avatar_url AS owner_avatar,
      (SELECT count(*) FROM plan_acl a WHERE a.plan_id = p.id) AS acl_count,
      (SELECT level FROM plan_acl a WHERE a.plan_id = p.id AND a.login = ?1) AS my_acl,
      p.search_text
    FROM plans p LEFT JOIN users u ON u.login = p.owner_login
    WHERE p.deleted_at IS NULL
      AND (p.owner_login = ?1 OR p.visibility = 'org' OR EXISTS (SELECT 1 FROM plan_acl a WHERE a.plan_id = p.id AND a.login = ?1))
    ORDER BY p.updated_at DESC`).bind(user.login).all()).results;
  const out = [];
  for (const p of rows) {
    const mine = p.owner_login === user.login;
    if (filter === "archived" ? !p.archived_at : p.archived_at) continue;
    if (filter === "mine" && !mine) continue;
    if (filter === "shared" && (mine || !p.my_acl)) continue;
    if (filter === "org" && p.visibility !== "org") continue;
    if (text && !(p.name + " " + (p.search_text || "") + " " + p.owner_login).toLowerCase().includes(text)) continue;
    const level = await levelFor(env, p, user, p.my_acl || null);
    out.push(publicMeta(p, level, { aclCount: p.acl_count, myAcl: p.my_acl || null }));
  }
  // Fork provenance: the source's name if the viewer may read it, else "private".
  const srcIds = [...new Set(out.filter((p) => p.forkedFrom).map((p) => p.forkedFrom.id))];
  if (srcIds.length) {
    const srcs = new Map();
    for (const sid of srcIds) srcs.set(sid, await getPlan(env, sid));
    for (const p of out) if (p.forkedFrom) p.forkedFromMeta = await forkSource(env, { forked_from_plan: p.forkedFrom.id, forked_from_hash: p.forkedFrom.hash }, user, srcs.get(p.forkedFrom.id));
  }
  return { plans: out, me: user.login };
}
async function forkSource(env, plan, user, src) {
  if (!plan.forked_from_plan) return null;
  src = src || await getPlan(env, plan.forked_from_plan);
  if (!src) return { id: plan.forked_from_plan, hash: plan.forked_from_hash, private: true, deleted: true };
  const lvl = await levelFor(env, src, user);
  if (!lvl) return { id: src.id, hash: plan.forked_from_hash, private: true };
  let summary = null;
  if (plan.forked_from_hash) { const n = await env.DB.prepare("SELECT summary FROM plan_nodes WHERE plan_id = ?1 AND hash = ?2").bind(src.id, plan.forked_from_hash).first(); summary = n ? n.summary : null; }
  return { id: src.id, hash: plan.forked_from_hash, name: src.name, owner: src.owner_login, summary, private: false };
}

// ── create ──
async function createPlan(ctx, user) {
  const { env, request } = ctx;
  const b = await body(request);
  const id = UUID_RE.test(b.id || "") ? b.id.toLowerCase() : crypto.randomUUID();
  const name = String(b.name || "Untitled plan").slice(0, 200);
  const now = Date.now();
  const exists = await env.DB.prepare("SELECT owner_login, deleted_at FROM plans WHERE id = ?1").bind(id).first();
  if (exists) return json({ error: "a plan with this id already exists", conflict: true }, 409);
  const visibility = VISIBILITY.includes(b.visibility) ? b.visibility : "private";
  await env.DB.prepare(`INSERT INTO plans (id, name, owner_login, created_at, updated_at, last_edit_by, visibility, edit_mode, search_text)
    VALUES (?1, ?2, ?3, ?4, ?4, ?3, ?5, 'owner', ?6)`).bind(id, name, user.login, Number(b.createdAt) || now, visibility, searchTextOf(name, null)).run();
  await logPlan(env, request, { actor: user.login, planId: id, action: b.imported ? "import" : "create", detail: { name } });
  const plan = await getPlan(env, id);
  return json(publicMeta(plan, "manage"), 201);
}

// ── meta: rename / sharing / archive ──
async function patchPlan(ctx, user, id) {
  const { env, request } = ctx;
  const { plan } = await requireLevel(env, id, user, "manage");
  const b = await body(request);
  const sets = [], args = [], detail = {};
  if (typeof b.name === "string" && b.name.trim()) { sets.push("name = ?"); args.push(b.name.trim().slice(0, 200)); detail.name = args[args.length - 1]; }
  let vis = plan.visibility, edit = plan.edit_mode;
  if (b.visibility !== undefined) { if (!VISIBILITY.includes(b.visibility)) return json({ error: "bad visibility" }, 400); vis = b.visibility; }
  if (b.editMode !== undefined) { if (!EDIT_MODE.includes(b.editMode)) return json({ error: "bad editMode" }, 400); edit = b.editMode; }
  if (RANK_EDIT[edit] > RANK_VIS[vis]) vis = VISIBILITY[RANK_EDIT[edit]];   // edit can never be broader than view
  if (vis !== plan.visibility) { sets.push("visibility = ?"); args.push(vis); detail.visibility = vis; }
  if (edit !== plan.edit_mode) { sets.push("edit_mode = ?"); args.push(edit); detail.editMode = edit; }
  if (typeof b.archived === "boolean" && !!plan.archived_at !== b.archived) { sets.push("archived_at = ?"); args.push(b.archived ? Date.now() : null); detail.archived = b.archived; }
  if (sets.length) {
    args.push(id);
    await env.DB.prepare(`UPDATE plans SET ${sets.map((s, i) => s.replace("?", "?" + (i + 1))).join(", ")} WHERE id = ?${args.length}`).bind(...args).run();
    const action = detail.archived !== undefined ? (detail.archived ? "archive" : "unarchive") : (detail.visibility || detail.editMode) ? "share" : "rename";
    await logPlan(env, request, { actor: user.login, planId: id, action, detail });
  }
  const fresh = await getPlan(env, id);
  return json(publicMeta(fresh, "manage"));
}
async function deletePlan(ctx, user, id) {
  const { env, request } = ctx;
  const { plan } = await requireLevel(env, id, user, "manage");
  const b = await body(request);
  if ((b.confirmName || "").trim() !== plan.name) return json({ error: "type the plan's exact name to confirm" }, 400);
  await env.DB.prepare("UPDATE plans SET deleted_at = ?1 WHERE id = ?2").bind(Date.now(), id).run();
  await logPlan(env, request, { actor: user.login, planId: id, action: "delete", detail: { name: plan.name } });
  return json({ ok: true });
}

// ── fork: a deep copy of the whole tree (rows copied, blobs shared by hash) ──
async function forkPlan(ctx, user, id) {
  const { env, request } = ctx;
  const { plan } = await requireLevel(env, id, user, "view");
  const b = await body(request);
  let at = HASH_RE.test(b.atHash || "") ? b.atHash : plan.head_hash;
  if (at && !(await env.DB.prepare("SELECT 1 AS ok FROM plan_nodes WHERE plan_id = ?1 AND hash = ?2").bind(id, at).first())) at = plan.head_hash;
  const nid = crypto.randomUUID();
  const name = String(b.name || (plan.name + " (fork)")).slice(0, 200);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO plans (id, name, owner_login, created_at, updated_at, last_edit_by, visibility, edit_mode, head_hash, root_hash, forked_from_plan, forked_from_hash, search_text)
      SELECT ?1, ?2, ?3, ?4, ?4, ?3, 'private', 'owner', ?5, root_hash, id, ?5, search_text FROM plans WHERE id = ?6`).bind(nid, name, user.login, now, at, id),
    env.DB.prepare(`INSERT INTO plan_nodes (plan_id, hash, parent_hash, sha256, summary, change_json, author_login, ts, active_child_hash, detached)
      SELECT ?1, hash, parent_hash, sha256, summary, change_json, author_login, ts, active_child_hash, detached FROM plan_nodes WHERE plan_id = ?2`).bind(nid, id),
  ]);
  if (at) await setHead(env, nid, at, user.login);
  await logPlan(env, request, { actor: user.login, planId: nid, action: "fork", nodeHash: at, detail: { from: id, fromName: plan.name } });
  await logPlan(env, request, { actor: user.login, planId: id, action: "forked", nodeHash: at, detail: { to: nid, name } });
  return json(publicMeta(await getPlan(env, nid), "manage"), 201);
}

// ── history tree ──
async function getTree(ctx, user, id) {
  const { env, request } = ctx;
  const { plan, level } = await requireLevel(env, id, user, "view");
  const nodes = (await env.DB.prepare(`SELECT hash, parent_hash AS parentHash, sha256, summary, author_login AS author, ts, active_child_hash AS activeChildHash, detached
    FROM plan_nodes WHERE plan_id = ?1 ORDER BY ts`).bind(id).all()).results;
  // "open" is logged at most once an hour per actor (or per anonymous IP) per plan.
  const actor = actorOf(user);
  const recent = await env.DB.prepare(`SELECT 1 AS ok FROM plan_events WHERE plan_id = ?1 AND action = 'open' AND ts > ?2 AND ${actor ? "actor_login = ?3" : "actor_login IS NULL AND ip_hash IS ?3"} LIMIT 1`)
    .bind(id, Date.now() - 3600 * 1000, actor || await ipHash(env, request)).first();
  if (!recent) await logPlan(env, request, { actor, planId: id, action: "open" });
  return json({ ...publicMeta(plan, level), nodes });
}
async function getNodes(ctx, user, id) {
  const { env, request } = ctx;
  await requireLevel(env, id, user, "view");
  const hashes = (new URL(request.url).searchParams.get("hashes") || "").split(",").filter((h) => HASH_RE.test(h)).slice(0, 50);
  if (!hashes.length) return json({ nodes: [] });
  const marks = hashes.map((_, i) => "?" + (i + 2)).join(",");
  const rows = (await env.DB.prepare(`SELECT n.hash, n.parent_hash AS parentHash, n.sha256, n.summary, n.change_json, n.author_login AS author, n.ts, n.active_child_hash AS activeChildHash, n.detached, b.body
    FROM plan_nodes n JOIN blobs b ON b.sha256 = n.sha256 WHERE n.plan_id = ?1 AND n.hash IN (${marks})`).bind(id, ...hashes).all()).results;
  return json({ nodes: rows.map((r) => ({ ...r, change: safeJSON(r.change_json), change_json: undefined })) });
}
const safeJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };

// Append nodes (idempotent by hash) with their snapshots; optionally move the head.
async function postNodes(ctx, user, id) {
  const { env, request } = ctx;
  const { plan } = await requireLevel(env, id, user, "edit");
  const b = await body(request);
  const nodes = Array.isArray(b.nodes) ? b.nodes.slice(0, 50) : [];
  const blobs = b.blobs && typeof b.blobs === "object" ? b.blobs : {};
  if (!nodes.length && !b.head) return json({ error: "nothing to do" }, 400);
  const actor = actorOf(user);
  const now = Date.now();
  const stmts = [], events = [];
  const haveBlob = new Set();
  for (const n of nodes) {
    if (!HASH_RE.test(n.hash || "") || (n.parentHash != null && !HASH_RE.test(n.parentHash)) || !/^[0-9a-f]{64}$/.test(n.sha256 || "")) return json({ error: "bad node " + (n.hash || "?") }, 400);
    const bodyStr = blobs[n.sha256];
    if (typeof bodyStr === "string" && !haveBlob.has(n.sha256)) {
      if (bodyStr.length > 1_900_000) return json({ error: "snapshot too large" }, 413);
      if ((await sha256Hex(bodyStr)) !== n.sha256) return json({ error: "sha256 mismatch for " + n.hash }, 400);
      let model; try { model = JSON.parse(bodyStr); validate(model); } catch (e) { return json({ error: "invalid snapshot for " + n.hash + ": " + e.message }, 400); }
      stmts.push(env.DB.prepare("INSERT OR IGNORE INTO blobs (sha256, body, bytes, created_at) VALUES (?1, ?2, ?3, ?4)").bind(n.sha256, bodyStr, bodyStr.length, now));
      haveBlob.add(n.sha256);
    } else if (!(await env.DB.prepare("SELECT 1 AS ok FROM blobs WHERE sha256 = ?1").bind(n.sha256).first())) {
      return json({ error: "missing snapshot for " + n.hash, missing: [n.sha256] }, 422);
    }
    stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO plan_nodes (plan_id, hash, parent_hash, sha256, summary, change_json, author_login, ts, active_child_hash, detached)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
      .bind(id, n.hash, n.parentHash || null, n.sha256, String(n.summary || "").slice(0, 300), JSON.stringify(n.change || {}), actor || "anon", Number(n.ts) || now, n.activeChildHash || null, n.detached ? 1 : 0));
    if (n.parentHash && n.activeChildHash === undefined) stmts.push(env.DB.prepare("UPDATE plan_nodes SET active_child_hash = ?1 WHERE plan_id = ?2 AND hash = ?3").bind(n.hash, id, n.parentHash));
    events.push({ hash: n.hash, summary: n.summary });
  }
  if (!plan.root_hash && nodes.length) { const root = nodes.find((n) => !n.parentHash) || nodes[0]; stmts.push(env.DB.prepare("UPDATE plans SET root_hash = ?1 WHERE id = ?2 AND root_hash IS NULL").bind(root.hash, id)); }
  for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
  for (const e of events) await logPlan(env, request, { actor, planId: id, action: "edit", nodeHash: e.hash, detail: { summary: e.summary } });
  let head = plan.head_hash;
  if (b.head && HASH_RE.test(b.head)) {
    const known = nodes.find((n) => n.hash === b.head) || await env.DB.prepare("SELECT 1 AS ok FROM plan_nodes WHERE plan_id = ?1 AND hash = ?2").bind(id, b.head).first();
    if (known) { const nb = nodes.find((n) => n.hash === b.head); await setHead(env, id, b.head, actor, nb ? blobs[nb.sha256] : null); head = b.head; }
  }
  const fresh = await env.DB.prepare("SELECT updated_at FROM plans WHERE id = ?1").bind(id).first();
  return json({ ok: true, added: nodes.length, head, updatedAt: fresh.updated_at });
}
async function postHead(ctx, user, id) {
  const { env, request } = ctx;
  await requireLevel(env, id, user, "edit");
  const b = await body(request);
  if (!HASH_RE.test(b.hash || "")) return json({ error: "bad hash" }, 400);
  const n = await env.DB.prepare("SELECT summary FROM plan_nodes WHERE plan_id = ?1 AND hash = ?2").bind(id, b.hash).first();
  if (!n) return json({ error: "unknown node" }, 404);
  await setHead(env, id, b.hash, actorOf(user));
  await logPlan(env, request, { actor: actorOf(user), planId: id, action: "jump", nodeHash: b.hash, detail: { summary: n.summary, label: b.label || null } });
  const fresh = await env.DB.prepare("SELECT updated_at FROM plans WHERE id = ?1").bind(id).first();
  return json({ ok: true, head: b.hash, updatedAt: fresh.updated_at });
}

// ── explicit per-user grants ──
async function acl(ctx, user, id, login) {
  const { env, request } = ctx;
  const m = request.method;
  const { plan } = await requireLevel(env, id, user, "manage");
  const list = async () => json({ acl: (await env.DB.prepare("SELECT login, level, granted_by, granted_at FROM plan_acl WHERE plan_id = ?1 ORDER BY granted_at").bind(id).all()).results });
  if (!login && m === "GET") return list();
  if (login && !LOGIN_RE.test(login)) return json({ error: "not a valid GitHub login" }, 400);
  if (login && m === "PUT") {
    const b = await body(request);
    if (b.level !== "view" && b.level !== "edit") return json({ error: "level must be view or edit" }, 400);
    if (login.toLowerCase() === plan.owner_login.toLowerCase()) return json({ error: "the owner already has full access" }, 400);
    await env.DB.prepare(`INSERT INTO plan_acl (plan_id, login, level, granted_by, granted_at) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(plan_id, login) DO UPDATE SET level = excluded.level, granted_by = excluded.granted_by, granted_at = excluded.granted_at`)
      .bind(id, login, b.level, user.login, Date.now()).run();
    await logPlan(env, request, { actor: user.login, planId: id, action: "share", detail: { login, level: b.level } });
    return list();
  }
  if (login && m === "DELETE") {
    await env.DB.prepare("DELETE FROM plan_acl WHERE plan_id = ?1 AND lower(login) = lower(?2)").bind(id, login).run();
    await logPlan(env, request, { actor: user.login, planId: id, action: "unshare", detail: { login } });
    return list();
  }
  return json({ error: "not found" }, 404);
}
