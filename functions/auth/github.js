// Start GitHub sign-in. State is HMAC-signed and carries the nonce + return path, and the
// nonce is double-submitted via a short-lived cookie so a state minted in one browser can't
// be replayed against another (login CSRF).
import { NONCE_COOKIE, cookie, isSecure, publicOrigin, redirect, secret, sign } from "../_lib/auth.js";

export async function onRequestGet({ request, env }) {
  if (!env.GITHUB_CLIENT_ID) return new Response("GITHUB_CLIENT_ID is not configured", { status: 500 });
  const url = new URL(request.url);
  const raw = url.searchParams.get("next") || "/";
  const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";   // same-origin only
  const nonce = crypto.randomUUID();
  const state = await sign({ t: "oauth", n: nonce, next, exp: Date.now() + 10 * 60 * 1000 }, secret(env));
  const gh = new URL("https://github.com/login/oauth/authorize");
  gh.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: publicOrigin(request, env) + "/auth/github/callback",
    scope: "read:org",          // private org memberships are invisible without it
    state,
    allow_signup: "false",
  }).toString();
  return redirect(gh.toString(), [cookie(NONCE_COOKIE, nonce, { maxAge: 600, secure: isSecure(request) })]);
}
