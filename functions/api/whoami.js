import { authenticate, handler, json } from "../_lib/auth.js";

export const onRequestGet = handler(async (ctx) => {
  const u = await authenticate(ctx);
  if (!u) return json({ error: "unauthenticated" }, 401);
  return json({ login: u.login, avatar: u.avatar, role: u.role, via: u.via });
});
