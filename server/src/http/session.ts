import { getCookie, setCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import { provisionWorkspace, type Services } from "../services.js";

export type AppEnv = { Variables: { workspaceId: string } };

export const SESSION_COOKIE = "relay_session";
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

/**
 * Resolves the caller's workspace from a signed, HttpOnly cookie and puts it
 * on the context. Route handlers read `c.get("workspaceId")` and pass it to
 * every store call; nothing takes a workspace id from the URL or body.
 *
 * There are no user accounts: a browser without a valid cookie gets a new
 * anonymous workspace. A multi-user deployment would swap this for real
 * authentication plus a workspace membership check.
 */
export function workspaceSession(services: Services): MiddlewareHandler<AppEnv> {
  const secure = services.config.publicUrl.startsWith("https://");
  return async (c, next) => {
    let workspaceId = services.sessions.verify(getCookie(c, SESSION_COOKIE));
    if (!workspaceId || !services.workspaces.get(workspaceId)) {
      workspaceId = provisionWorkspace(services).id;
      setCookie(c, SESSION_COOKIE, services.sessions.sign(workspaceId), {
        httpOnly: true,
        sameSite: "Lax", // sent on the top-level redirect back from the OAuth provider
        secure,
        path: "/",
        maxAge: ONE_YEAR_SECONDS,
      });
    }
    c.set("workspaceId", workspaceId);
    await next();
  };
}
