/**
 * Minimum time between sending a create and a retry that searches
 * its marker: longer than the HTTP read timeout plus Odoo's
 * default limit_time_real (120 s), so a create still running on the server
 * has committed — or been killed — before the search.
 */
export const CREATE_QUIET_WINDOW_MS = 3 * 60 * 1000;

/**
 * Text the app writes in a record it creates, searched to find that record
 * again when the answer to create() was lost.
 */
export function clientMarker(clientUuid: string): string {
  return `erplibre-mobile:${clientUuid}`;
}
