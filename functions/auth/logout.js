import { SESSION_COOKIE, authenticate, cookie, isSecure, logAuth } from "../_lib/auth.js";

export async function onRequestPost(ctx) {
  const u = await authenticate(ctx);
  if (u) await logAuth(ctx.env, ctx.request, { login: u.login, event: "signout" });
  return new Response(null, { status: 204, headers: { "set-cookie": cookie(SESSION_COOKIE, "", { maxAge: 0, secure: isSecure(ctx.request) }), "cache-control": "no-store" } });
}
