import { useRouteContext } from "@tanstack/react-router";
import { type AuthState, LOCAL_AUTH_STATE } from "./types";

const FALLBACK: AuthState = LOCAL_AUTH_STATE;

/**
 * Read the auth state that the root route's `beforeLoad` placed in router context. Client-only and
 * SDK-free — components get the identity without importing any provider code. Falls back to the open
 * local-user state if context is somehow unset rather than throwing.
 */
export function useAuthState(): AuthState {
  return useRouteContext({
    from: "__root__",
    select: (ctx) => (ctx as { auth?: AuthState }).auth ?? FALLBACK,
  });
}
