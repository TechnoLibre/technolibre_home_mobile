/** localStorage key of the "allow unencrypted http" option. */
export const ALLOW_HTTP_KEY = "options.sync.allowHttp";

/**
 * Raised before any request to an http:// server while the option is
 * off: the password and the session cookie would cross the network in
 * clear text.
 */
export class InsecureHttpError extends Error {}

/**
 * Whether http:// servers may be contacted: off unless the user turned
 * the option on. Unreadable storage (private mode, blocked) counts as off.
 */
export function isHttpAllowed(): boolean {
  try {
    return globalThis.localStorage?.getItem(ALLOW_HTTP_KEY) === "true";
  } catch {
    return false;
  }
}

const listeners = new Set<(allowed: boolean) => void>();

/**
 * Calls `listener` with the value each time setHttpAllowed sets the
 * option (the native chat push mirrors it); returns the unsubscribe. A
 * listener that throws is logged and the others still run.
 */
export function onHttpPolicyChange(listener: (allowed: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setHttpAllowed(allowed: boolean): void {
  try {
    globalThis.localStorage?.setItem(ALLOW_HTTP_KEY, allowed ? "true" : "false");
  } catch {
    // Storage unavailable: the option stays off
  }
  for (const listener of [...listeners]) {
    try {
      listener(allowed);
    } catch (e) {
      console.warn("[http policy] listener failed:", e);
    }
  }
}

/** Throws InsecureHttpError for an http:// url while the option is off. */
export function assertUrlAllowed(url: string): void {
  if (/^http:\/\//i.test(url.trim()) && !isHttpAllowed()) {
    throw new InsecureHttpError(
      `Connexion http non chiffrée refusée pour ${url}. `
        + "Activez « Autoriser http (non chiffré) » dans Options › Synchronisation Odoo, "
        + "ou utilisez https."
    );
  }
}
