// One-time hand-off of saved plans from the old host (openathena.ai/plantt).
//
// localStorage is per origin, so moving hosts would have stranded every saved plan, and a
// hidden iframe cannot help because browsers partition third-party storage. So the old
// host's page (redirect/index.html) POSTs its plans here as a normal top-level form
// submission; we park them under a random token for an hour and bounce the browser to
// /?legacy=<token>, where the app fetches them once (see importLegacyHandoff in main.js).
const TTL_MS = 60 * 60 * 1000;
const KEY_OK = /^(tg-|tufte-gantt-|plantt[-_])/;   // the app's localStorage namespaces
const MAX_VALUE = 1_900_000;                       // D1 caps a row at 2 MB

export async function onRequestPost({ request, env }) {
  let items;
  try { items = JSON.parse((await request.formData()).get("items") || "{}"); }
  catch { return new Response("bad payload", { status: 400 }); }
  const form = await request.clone().formData().catch(() => null);
  let hash = String((form && form.get("hash")) || "");
  if (!/^#[A-Za-z0-9+\-_%.~]*$/.test(hash)) hash = "";   // only a plausible lz-string fragment

  const entries = Object.entries(items || {})
    .filter(([k, v]) => KEY_OK.test(k) && typeof v === "string" && v.length <= MAX_VALUE);
  const token = crypto.randomUUID();
  const now = Date.now();
  const ins = env.DB.prepare("INSERT INTO legacy_handoff (token, key, value, created_at) VALUES (?1, ?2, ?3, ?4)");
  for (let i = 0; i < entries.length; i += 50)
    await env.DB.batch(entries.slice(i, i + 50).map(([k, v]) => ins.bind(token, k, v, now)));
  await env.DB.prepare("DELETE FROM legacy_handoff WHERE created_at < ?1").bind(now - TTL_MS).run();

  return Response.redirect(new URL("/?legacy=" + token + hash, request.url).toString(), 303);
}

export async function onRequestGet({ env, params }) {
  const token = (params.path || [])[0];
  if (!token) return new Response("not found", { status: 404 });
  const { results } = await env.DB
    .prepare("SELECT key, value FROM legacy_handoff WHERE token = ?1 AND created_at > ?2")
    .bind(token, Date.now() - TTL_MS).all();
  if (!results.length) return Response.json({ items: {} }, { status: 404 });
  await env.DB.prepare("DELETE FROM legacy_handoff WHERE token = ?1").bind(token).run(); // read once
  const items = {};
  for (const r of results) items[r.key] = r.value;
  return Response.json({ items }, { headers: { "cache-control": "no-store" } });
}
