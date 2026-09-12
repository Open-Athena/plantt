// Smoke check for the deploy pipeline: proves Pages Functions run and the D1 binding works.
export async function onRequestGet({ env }) {
  let db;
  try {
    const r = await env.DB.prepare("SELECT count(*) AS n FROM plans").first();
    db = { ok: true, plans: r.n };
  } catch (e) {
    db = { ok: false, error: String(e && e.message || e) };
  }
  return Response.json({ ok: true, db, ts: Date.now() }, { headers: { "cache-control": "no-store" } });
}
