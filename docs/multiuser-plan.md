# plantt multi-user: sign-in, sharing, forking, plan index, audit

Design agreed 2026-09-11 (Isaac + Claude). Implementation lands on the `multiuser` branch in phases;
this file is the reference for what "done" means. It supersedes nothing in `AGENTS.md`; the schema,
op vocabulary and relay contract rules there still hold.

## Decisions already made

| Topic | Decision |
|---|---|
| Hosting | Move to Cloudflare Pages + Pages Functions + D1 in the Open Athena account (`74981a43…`), at `plantt.oa.dev`. `openathena.ai/plantt` becomes a redirect that preserves the `#` fragment. Deploys run from GitHub Actions on push to `main`; PRs get Pages preview URLs. |
| Identity | GitHub OAuth (org-owned OAuth app). Identity is the GitHub login. No auth library; ~300 lines of our own Worker code (HMAC session cookie, code exchange, org-membership check). |
| Who may sign in | `admins` env list (seeded with `ihodes`) OR `allowed_users` table OR active member of the `Open-Athena` org. Policy re-evaluated on every request, so removing someone takes effect immediately. |
| Roles | `admin` (manage allowlist, read audit log) and `member`. Admins have **no** special access to plans they were not shared on. |
| Plans | Everything syncs once signed in. Not signed in = today's localStorage-only app, unchanged. |
| Lifecycle | Archive (hidden from default index view, reversible) or delete (soft, requires typing the plan name). No "close". |
| Retention | Indefinite for nodes, snapshots and audit rows. Pruning later. |
| Fork provenance | Exact source node, linked. Shown as "private" when the viewer cannot read the source plan. |
| Hashes | Tree identity keeps the existing 64-bit `cyrb53(canonicalJSON + parentHash)`. Snapshot blobs are keyed by SHA-256 server-side. |
| Non-member share links (minted tokens) | Later. Not in this branch. |

## Sharing model

Two independent axes on every plan, plus explicit per-user grants. Edit always implies view.

```
plans.visibility : 'private' | 'org' | 'public'     -- who can VIEW
plans.edit_mode  : 'owner'   | 'org' | 'public'     -- who can EDIT
plan_acl(plan_id, login, level 'view' | 'edit')     -- explicit per-user grants
```

Effective level for a request is the **maximum** of:

- owner → `manage`
- `plan_acl` row for the login → its level
- `visibility='org'` and requester is a signed-in member → `view`
- `edit_mode='org'` and requester is a signed-in member → `edit`
- `visibility='public'` → `view` for anyone, signed in or not
- `edit_mode='public'` → `edit` for anyone, signed in or not

Rules the API enforces (the share dialog only offers legal combinations):

- `edit_mode` can never be broader than `visibility` (`public` edit forces `public` visibility; `org` edit forces at least `org` visibility). A `plan_acl` edit grant on a private plan is fine: that person sees it because of the grant.
- Only `manage` (the owner) can change visibility, edit mode, ACL, archive, delete, or rename the plan. Ownership does not transfer in v1.
- Public plans are **unlisted**: they never appear in anyone else's index. You reach them by link.
- Anonymous edits (public edit mode) are recorded with author `anon` plus an IP hash, and are visible as such in the history tree and audit log. Recovery is the undo tree.
- The index lists plans where the requester is owner, has an ACL row, or (`visibility` ∈ {org}) is a member. Filters: mine / shared with me / org / archived.

The share dialog, top to bottom: **Who can see** (Only me / Open Athena / Anyone with the link), **Who can edit** (Only me / Open Athena / Anyone with the link, constrained by the above), then **People** (GitHub login autocomplete from the org member list, each with view or edit), then the link itself with a copy button.

## Data model (D1)

```sql
users        (login PK, github_id, avatar_url, role 'admin'|'member', added_by, added_at, last_seen_at)
allowed_users(login PK, added_by, added_at, note)               -- the whitelist
plans        (id TEXT PK /* uuid */, name, owner_login, created_at, updated_at, last_edit_by,
              visibility, edit_mode, head_hash, root_hash,
              forked_from_plan, forked_from_hash, archived_at, deleted_at,
              search_text /* name + workstream + task names of head, refreshed on head move */,
              view_prefs_json /* owner's today/compact/hidden toggles; per-user later */)
plan_nodes   (plan_id, hash, parent_hash, summary, change_json, author_login, ts, active_child_hash,
              detached, PRIMARY KEY(plan_id, hash))
blobs        (sha256 PK, body TEXT, bytes)                       -- snapshots, shared across plans
plan_acl     (plan_id, login, level, granted_by, granted_at, PRIMARY KEY(plan_id, login))
plan_events  (id, ts, actor_login, plan_id, action, node_hash, detail_json, ip_hash)
auth_events  (id, ts, login, event 'signin'|'signout'|'deny'|'allow_add'|'allow_remove'|'role_change',
              detail, ip_hash, ua)
```

Notes:

- D1 caps a row at 2 MB, so snapshots are one row each, never one JSON blob per plan. Because the tree is
  content-addressed, a fork inserts new `plan_nodes` rows and reuses `blobs` rows; storage cost of a
  fork is metadata only, semantics are a deep copy.
- Client-local integer node ids stay client-local. The wire format speaks hashes.
- The local tree keeps `HISTORY_LIMIT = 500` and prunes for display/memory; the server keeps every node.

## Sync model (concurrency v1)

Append-only, content-addressed, last-writer-moves-head.

1. Every local `recordChange` / import / jump posts `{hash, parentHash, summary, change, snapshot?}`;
   `snapshot` is omitted when the server already has that sha256 (`HEAD /blobs/:sha`). Writes queue
   offline and flush in order.
2. `POST /api/plans/:id/nodes` inserts the node (idempotent by hash) and moves `head_hash` to it.
3. The tab polls `GET /api/plans/:id/head` every 4 s while visible (immediately on `focus`). If the
   head moved and it is not ours:
   - our current node is an ancestor of the new head → fast-forward silently (fetch the missing nodes,
     graft, jump). This is the common case: one person editing at a time.
   - otherwise → graft the remote nodes as a sibling branch, keep the user where they are, and toast
     "@login also edited this plan" with a **Jump** button. Nothing is ever lost; the history tree
     shows both branches.
4. Same-parent races are just two branches. No locking.

Upgrade path (not now): a Durable Object per plan pushing new nodes over a WebSocket, plus presence
avatars. Same node format, same graft logic; only the transport changes. Automatic rebase of
non-overlapping edits (ops touch disjoint item names) is possible later because `apply(ops)` is
already name-addressed.

## Links

| URL | Needs | Loads from |
|---|---|---|
| `/p/<uuid>` | sign-in + view level, or `visibility='public'` | database |
| `/#<lz-string>` | nothing | the URL itself, exactly as today ("export") |
| `/p/<uuid>#<lz-string>` | as above | database, then grafts the fragment by hash as the app does today |

"Export as URL" is the existing `encodeState()` unchanged. Opening an export link while signed in
imports it as a **new** synced plan unless the uuid names a plan the user can read, in which case the
existing graft/load/detached reconciliation runs against the server tree.

## HTTP API (Pages Functions)

All JSON. Auth = session cookie, or `Authorization: Bearer <personal token>` (phase 4). Every write is
logged to `plan_events`.

```
GET  /auth/github            → 302 to GitHub (state HMAC'd, nonce double-submitted in a cookie)
GET  /auth/github/callback   → exchange code, GET /user, GET /user/memberships/orgs/Open-Athena, policy, set cookie
POST /auth/logout
GET  /api/whoami             → { login, avatar, role } | 401

GET  /api/plans?filter=mine|shared|org|archived&q=&sort=
POST /api/plans              { name, model?, importHistory? }          → create (also the local-import path)
GET  /api/plans/:id          → meta + effective level
PATCH/api/plans/:id          { name?, visibility?, edit_mode?, archived? }   (manage)
DELETE /api/plans/:id        { confirmName }                                  (manage; soft)
POST /api/plans/:id/fork     { atHash?, name? }                              (view)
GET  /api/plans/:id/tree     → nodes (no snapshots)
GET  /api/plans/:id/head
GET  /api/plans/:id/nodes/:hash  → node + snapshot
POST /api/plans/:id/nodes    { hash, parentHash, summary, change, snapshot? } (edit)
HEAD /api/blobs/:sha256
GET  /api/plans/:id/acl · PUT /api/plans/:id/acl/:login {level} · DELETE …   (manage)
GET  /api/org/members?q=     → login autocomplete (cached server-side, 10 min)

GET  /api/admin/users · POST /api/admin/allow {login} · DELETE /api/admin/allow/:login · PATCH role
GET  /api/admin/audit?plan=&actor=&since=&kind=
GET  /api/plans/:id/events   → per-plan audit (manage)
```

Agents: phase 1 changes nothing (a signed-in tab polling the relay routes every edit through the same
internals, so sync is automatic and `plans.*` starts returning server plans). Phase 4 adds
`POST /api/plans/:id/apply { ops, summary }` with the relay's exact body, which requires lifting
`_applyOp` and helpers out of `src/main.js` into a pure `src/ops.js` that both the browser and the
Worker import. `npm test` keeps enforcing `OPS` ⇔ `_applyOp` parity.

## Phases

1. **Move hosting, no visible change.** `wrangler.toml`, D1 database, `plantt.oa.dev`, GitHub Actions
   deploy (tests → build → migrations → `wrangler pages deploy`), preview deploys on PRs, redirect stub
   on GitHub Pages. Factor `src/ops.js`.
2. **Sign-in + roles + audit.** GitHub OAuth, policy, session cookie, whoami chip in the toolbar,
   admin page (allowlist, roles), audit log page. Plans still local.
3. **Synced plans.** Node sync + head polling, plan index page (replaces the Plans modal when signed
   in), share dialog + ACL, fork, archive/delete, one-time "import your local plans" prompt.
4. **Agents without a tab + polish.** Personal tokens, `/api/plans/:id/apply`, FTS search if `LIKE`
   is not enough, view-event logging, non-member minted links.

## Operational

- Secrets (Pages project): `SESSION_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`. Vars:
  `ADMIN_LOGINS=ihodes`, `GITHUB_ORG=Open-Athena`.
- GitHub repo secret: `CLOUDFLARE_API_TOKEN` (scoped to the OA account: Pages edit, D1 edit, Workers
  scripts edit). Repo variable: `CLOUDFLARE_ACCOUNT_ID`.
- Local dev: `wrangler pages dev -- vite` with `.dev.vars` (gitignored) holding a second OAuth app's
  credentials whose callback is `http://localhost:8788/auth/github/callback`.
- Backups: D1 Time Travel (30 days) plus a nightly `wrangler d1 export` to R2 later.
