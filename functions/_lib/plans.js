// Plan access rules and shared helpers for /api/plans. See docs/multiuser-plan.md "Sharing model".
import { json } from "./auth.js";

export const PLAN_COLS = `p.id, p.name, p.owner_login, p.created_at, p.updated_at, p.last_edit_by, p.visibility, p.edit_mode,
  p.head_hash, p.root_hash, p.forked_from_plan, p.forked_from_hash, p.archived_at`;
export const VISIBILITY = ["private", "org", "public"];
export const EDIT_MODE = ["owner", "org", "public"];
const RANK = { view: 1, edit: 2, manage: 3 };
const max = (a, b) => (!a ? b : !b ? a : RANK[a] >= RANK[b] ? a : b);
export const atLeast = (lvl, need) => !!lvl && RANK[lvl] >= RANK[need];
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HASH_RE = /^[0-9a-f]{16}$/;

export async function getPlan(env, id) {
  if (!UUID_RE.test(id || "")) return null;
  return env.DB.prepare(`SELECT ${PLAN_COLS}, u.avatar_url AS owner_avatar FROM plans p LEFT JOIN users u ON u.login = p.owner_login
    WHERE p.id = ?1 AND p.deleted_at IS NULL`).bind(id).first();
}

// Effective level = max over owner / explicit grant / org-wide / public. `myAcl` may be passed
// when the caller already joined it (the index query), to save a round trip per row.
export async function levelFor(env, plan, user, myAcl) {
  if (!plan) return null;
  if (user && plan.owner_login === user.login) return "manage";
  let lvl = null;
  if (plan.visibility === "public") lvl = max(lvl, "view");
  if (plan.edit_mode === "public") lvl = max(lvl, "edit");
  if (user) {
    if (plan.visibility === "org") lvl = max(lvl, "view");
    if (plan.edit_mode === "org") lvl = max(lvl, "edit");
    if (myAcl === undefined) {
      const row = await env.DB.prepare("SELECT level FROM plan_acl WHERE plan_id = ?1 AND login = ?2").bind(plan.id, user.login).first();
      myAcl = row ? row.level : null;
    }
    if (myAcl) lvl = max(lvl, myAcl);
  }
  return lvl;
}

// Load + authorize in one step. A private plan answers 401 to strangers (so the client can
// offer sign-in) and 403 to signed-in users without access.
export async function requireLevel(env, id, user, need) {
  const plan = await getPlan(env, id);
  if (!plan) throw json({ error: "not found" }, 404);
  const level = await levelFor(env, plan, user);
  if (!atLeast(level, need)) throw json({ error: user ? "forbidden" : "unauthenticated", private: true }, user ? 403 : 401);
  return { plan, level };
}

// What the index shows for a plan: its meta plus the viewer's level and a sharing summary.
export function publicMeta(plan, level, extra = {}) {
  return {
    id: plan.id, name: plan.name, owner: plan.owner_login, ownerAvatar: plan.owner_avatar || null,
    createdAt: plan.created_at, updatedAt: plan.updated_at, lastEditBy: plan.last_edit_by,
    visibility: plan.visibility, editMode: plan.edit_mode, head: plan.head_hash, root: plan.root_hash,
    forkedFrom: plan.forked_from_plan ? { id: plan.forked_from_plan, hash: plan.forked_from_hash } : null,
    archived: !!plan.archived_at, level, ...extra,
  };
}

// name + workstream + task/milestone names, so the index can search inside plans cheaply.
export function searchTextOf(name, model) {
  const parts = [name || "", (model && model.title) || ""];
  for (const ws of (model && model.workstreams) || []) {
    parts.push(ws.name || "");
    for (const t of ws.tasks || []) parts.push(t.name || "", t.assigned || "");
    for (const m of ws.milestones || []) parts.push(m.name || "", m.assigned || "");
  }
  return parts.filter(Boolean).join(" ").slice(0, 20000);
}

export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Move the tip. `body` is the head snapshot's JSON when the caller has it (saves a read).
export async function setHead(env, planId, hash, actor, body) {
  if (body == null) {
    const row = await env.DB.prepare("SELECT b.body FROM plan_nodes n JOIN blobs b ON b.sha256 = n.sha256 WHERE n.plan_id = ?1 AND n.hash = ?2").bind(planId, hash).first();
    body = row ? row.body : null;
  }
  let search = null;
  if (body) { try { const p = await env.DB.prepare("SELECT name FROM plans WHERE id = ?1").bind(planId).first(); search = searchTextOf(p && p.name, JSON.parse(body)); } catch { /* keep old */ } }
  await env.DB.prepare(`UPDATE plans SET head_hash = ?1, updated_at = ?2, last_edit_by = ?3, search_text = COALESCE(?4, search_text) WHERE id = ?5`)
    .bind(hash, Date.now(), actor || null, search, planId).run();
}
