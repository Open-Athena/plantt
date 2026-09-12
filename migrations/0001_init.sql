-- plantt multi-user schema. See docs/multiuser-plan.md.
-- Timestamps are epoch milliseconds (INTEGER) to match Date.now() in the app.

-- Everyone who has ever signed in. `role` is admin | member.
CREATE TABLE users (
  login         TEXT PRIMARY KEY,          -- GitHub login, the identity everywhere
  github_id     INTEGER NOT NULL,
  avatar_url    TEXT,
  role          TEXT NOT NULL DEFAULT 'member',
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

-- The whitelist. Org members are admitted without a row here; this is for everyone else.
CREATE TABLE allowed_users (
  login    TEXT PRIMARY KEY,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  note     TEXT
);

CREATE TABLE plans (
  id               TEXT PRIMARY KEY,       -- uuid, same value the client uses
  name             TEXT NOT NULL,
  owner_login      TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  last_edit_by     TEXT,
  visibility       TEXT NOT NULL DEFAULT 'private',  -- private | org | public   (who can view)
  edit_mode        TEXT NOT NULL DEFAULT 'owner',    -- owner | org | public     (who can edit)
  head_hash        TEXT,                              -- current tip of the history tree
  root_hash        TEXT,
  forked_from_plan TEXT,                              -- provenance: plan id + exact node
  forked_from_hash TEXT,
  archived_at      INTEGER,
  deleted_at       INTEGER,                           -- soft delete
  search_text      TEXT NOT NULL DEFAULT '',          -- name + workstream/task names of head
  view_prefs_json  TEXT                               -- owner's today/compact/hidden toggles
);
CREATE INDEX plans_owner      ON plans (owner_login, updated_at DESC);
CREATE INDEX plans_visibility ON plans (visibility, updated_at DESC);

-- The undo TREE, one row per node. Snapshots live in `blobs`, keyed by sha256, so a
-- fork copies rows here and shares blobs (D1 caps a row at 2 MB; never inline them).
CREATE TABLE plan_nodes (
  plan_id           TEXT NOT NULL,
  hash              TEXT NOT NULL,          -- client tree hash: cyrb53(canonicalJSON + parentHash)
  parent_hash       TEXT,                   -- NULL = root or detached head
  sha256            TEXT NOT NULL,          -- -> blobs.sha256 (the snapshot)
  summary           TEXT NOT NULL,
  change_json       TEXT NOT NULL,          -- the change descriptor
  author_login      TEXT,                   -- NULL/'anon' for unauthenticated public edits
  ts                INTEGER NOT NULL,
  active_child_hash TEXT,                   -- linear-redo pointer, as in the client
  detached          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (plan_id, hash)
);
CREATE INDEX plan_nodes_parent ON plan_nodes (plan_id, parent_hash);

CREATE TABLE blobs (
  sha256     TEXT PRIMARY KEY,
  body       TEXT NOT NULL,                 -- canonical JSON of the model snapshot
  bytes      INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Explicit per-user grants. level is view | edit. Owner is implicit (plans.owner_login).
CREATE TABLE plan_acl (
  plan_id    TEXT NOT NULL,
  login      TEXT NOT NULL,
  level      TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (plan_id, login)
);
CREATE INDEX plan_acl_login ON plan_acl (login);

-- Audit: plan actions (create, open, edit, fork, share, unshare, archive, delete, ...).
CREATE TABLE plan_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  actor_login TEXT,                         -- NULL = anonymous
  plan_id     TEXT NOT NULL,
  action      TEXT NOT NULL,
  node_hash   TEXT,
  detail_json TEXT,
  ip_hash     TEXT                          -- HMAC(ip, SESSION_SECRET); raw IPs are never stored
);
CREATE INDEX plan_events_plan ON plan_events (plan_id, ts DESC);
CREATE INDEX plan_events_ts   ON plan_events (ts DESC);

-- Audit: sign-in lifecycle and admin actions (signin, signout, deny, allow_add, allow_remove, role_change).
CREATE TABLE auth_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  login   TEXT,
  event   TEXT NOT NULL,
  detail  TEXT,
  ip_hash TEXT,
  ua      TEXT
);
CREATE INDEX auth_events_ts ON auth_events (ts DESC);

-- One-time hand-off of localStorage plans from the old host (openathena.ai/plantt), which
-- parks them under a random token for an hour. See redirect/index.html + functions/api/legacy.
CREATE TABLE legacy_handoff (
  token      TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (token, key)
);
