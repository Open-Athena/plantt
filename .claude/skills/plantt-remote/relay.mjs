#!/usr/bin/env node
// plantt remote-control relay.
//
// A localhost HTTP bridge between an external tool (the skill, via curl) and a live
// plantt tab. The plantt page CANNOT listen on a socket, so it POLLS this relay; this
// relay holds the page's GET /poll open (long-poll) until a command is queued.
//
// The page-facing responses carry CORS + Private Network Access headers so a hosted
// HTTPS plantt tab is allowed to reach this loopback server (verified on Chrome 148).
//
//   page-facing   GET  /poll    long-poll; -> { commands: [...] }
//                 POST /ack      body { results:[{id,ok,error}], state:{uuid,name,model} }
//   tool-facing   GET  /status   -> { connected, lastSeen, hasState }
//                 GET  /state    enqueue getState, wait for ack -> { ok, state }
//                 POST /edit     body { model, summary } -> { ok, error, state }
//                 POST /shutdown -> stops the relay
//
// Binds 127.0.0.1 only. No auth token by design — the tool kills it when finished.

import http from "node:http";

const PORT = Number(process.env.PLANTT_RELAY_PORT || 8787);
const POLL_TIMEOUT = 25_000;   // long-poll: return empty after this so the page re-polls
const RESULT_TIMEOUT = 30_000; // how long a tool call waits for the page to ack

let queue = [];          // commands waiting to be polled
let waiters = [];        // parked GET /poll responders: fn(commands)
const pending = new Map(); // command id -> { resolve } for tool calls awaiting page ack
let lastState = null;     // most recent state the page acked
let lastSeen = 0;         // last time the page talked to us
let nextId = 1;

const corsHeaders = (req) => ({
  "Access-Control-Allow-Origin": req.headers.origin || "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Private-Network": "true", // the bit that lets https->loopback through
  "Access-Control-Max-Age": "86400",
});

function flush() {
  // Hand the whole queued batch to one parked poller.
  if (!queue.length || !waiters.length) return;
  const give = waiters.shift();
  const cmds = queue;
  queue = [];
  give(cmds);
}

function enqueue(cmd) {
  return new Promise((resolve, reject) => {
    cmd.id = nextId++;
    pending.set(cmd.id, { resolve });
    queue.push(cmd);
    flush();
    setTimeout(() => {
      if (pending.has(cmd.id)) {
        pending.delete(cmd.id);
        reject(new Error("timeout: plantt tab did not respond (is it open with ?agent=1?)"));
      }
    }, RESULT_TIMEOUT);
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}
const send = (res, code, obj, headers = {}) => {
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  const h = corsHeaders(req);
  if (req.method === "OPTIONS") { res.writeHead(204, h); res.end(); return; }

  try {
    // ── page-facing ──
    if (path === "/poll" && req.method === "GET") {
      lastSeen = Date.now();
      if (queue.length) { const cmds = queue; queue = []; return send(res, 200, { commands: cmds }, h); }
      const give = (cmds) => { clearTimeout(timer); send(res, 200, { commands: cmds }, h); };
      const timer = setTimeout(() => {
        waiters = waiters.filter((w) => w !== give);
        send(res, 200, { commands: [] }, h);
      }, POLL_TIMEOUT);
      waiters.push(give);
      return;
    }
    if (path === "/ack" && req.method === "POST") {
      lastSeen = Date.now();
      const body = await readBody(req);
      if (body.state) lastState = body.state;        // set BEFORE resolving so /state sees it
      for (const r of body.results || []) {
        const p = pending.get(r.id);
        if (p) { pending.delete(r.id); p.resolve(r); }
      }
      return send(res, 200, { ok: true }, h);
    }

    // ── tool-facing (localhost) ──
    const q = new URL(req.url, "http://localhost").searchParams;
    if (path === "/status" && req.method === "GET") {
      return send(res, 200, { connected: Date.now() - lastSeen < 30_000, lastSeen, hasState: !!lastState });
    }
    // reads -> return the page's result `data`
    if (path === "/schema" && req.method === "GET") {
      const r = await enqueue({ type: "describe" });
      return send(res, 200, { ok: r.ok, schema: r.data });
    }
    if (path === "/state" && req.method === "GET") {
      const r = await enqueue({ type: "getState" });
      return send(res, 200, { ok: r.ok, state: r.data });
    }
    if (path === "/outline" && req.method === "GET") {
      const r = await enqueue({ type: "outline" });
      return send(res, 200, { ok: r.ok, outline: r.data });
    }
    if (path === "/get" && req.method === "GET") {
      const r = await enqueue({ type: "get", name: q.get("name") });
      return send(res, 200, { ok: r.ok, item: r.data });
    }
    if (path === "/deps" && req.method === "GET") {
      const r = await enqueue({ type: "getDeps", name: q.get("name") });
      return send(res, 200, { ok: r.ok, deps: r.data });
    }
    if (path === "/dependents" && req.method === "GET") {
      const r = await enqueue({ type: "getDependents", name: q.get("name") });
      return send(res, 200, { ok: r.ok, dependents: r.data });
    }
    // writes
    if (path === "/apply" && req.method === "POST") {
      const body = await readBody(req);
      if (!Array.isArray(body.ops))
        return send(res, 400, { ok: false, error: "POST body must be { ops: [...], summary }" });
      const r = await enqueue({ type: "apply", ops: body.ops, summary: body.summary });
      return send(res, 200, { ok: r.ok, error: r.error, applied: r.applied, state: lastState });
    }
    if (path === "/edit" && req.method === "POST") {
      const body = await readBody(req);
      if (!body || typeof body.model !== "object")
        return send(res, 400, { ok: false, error: "POST body must be { model, summary }" });
      const r = await enqueue({ type: "setModel", model: body.model, summary: body.summary });
      return send(res, 200, { ok: r.ok, error: r.error, state: lastState });
    }
    // plans (saved-plan management; list/get don't switch, open/duplicate/create do)
    if (path === "/plans" && req.method === "GET") {
      const r = await enqueue({ type: "plans.list" });
      return send(res, 200, { ok: r.ok, plans: r.data });
    }
    if (path === "/plans/get" && req.method === "GET") {
      const r = await enqueue({ type: "plans.get", uuid: q.get("uuid") });
      return send(res, 200, { ok: r.ok, plan: r.data });
    }
    if (path === "/plans/open" && req.method === "POST") {
      const body = await readBody(req);
      const r = await enqueue({ type: "plans.open", uuid: body.uuid });
      return send(res, 200, { ...r, state: lastState });
    }
    if (path === "/plans/duplicate" && req.method === "POST") {
      const body = await readBody(req);
      const r = await enqueue({ type: "plans.duplicate", uuid: body.uuid, name: body.name, open: body.open });
      return send(res, 200, { ...r, state: lastState });
    }
    if (path === "/plans/create" && req.method === "POST") {
      const body = await readBody(req);
      const r = await enqueue({ type: "plans.create", name: body.name, model: body.model, open: body.open });
      return send(res, 200, { ...r, state: lastState });
    }
    // themes (local-only; follow OS light/dark)
    if (path === "/themes" && req.method === "GET") {
      const r = await enqueue({ type: "themes.list" });
      return send(res, 200, { ok: r.ok, themes: r.data });
    }
    if (path === "/theme/current" && req.method === "GET") {
      const r = await enqueue({ type: "themes.current" });
      return send(res, 200, { ok: r.ok, current: r.data });
    }
    if (path === "/theme/get" && req.method === "GET") {
      const r = await enqueue({ type: "themes.get", themeId: q.get("id") });
      return send(res, 200, { ok: r.ok, theme: r.data });
    }
    if (path === "/theme/set" && req.method === "POST") {
      const body = await readBody(req);
      const r = await enqueue({ type: "themes.set", slot: body.slot, themeId: body.id });
      return send(res, 200, r);
    }
    if (path === "/theme/import" && req.method === "POST") {
      const body = await readBody(req);
      const r = await enqueue({ type: "themes.import", theme: body.theme != null ? body.theme : body });
      return send(res, 200, r);
    }
    if (path === "/theme/export" && req.method === "GET") {
      const r = await enqueue({ type: "themes.export", themeId: q.get("id") || null });
      return send(res, 200, r);
    }
    if (path === "/theme/remove" && req.method === "POST") {
      const body = await readBody(req);
      const r = await enqueue({ type: "themes.remove", themeId: body.id });
      return send(res, 200, r);
    }
    if (path === "/shutdown" && req.method === "POST") {
      send(res, 200, { ok: true });
      return setImmediate(() => process.exit(0));
    }

    send(res, 404, { error: "not found" }, h);
  } catch (e) {
    send(res, 502, { ok: false, error: String(e.message || e) }, h);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`plantt relay listening on http://127.0.0.1:${PORT}`);
});
