/**
 * The setup link of an ntfy server for the phone, as the operator's tool
 * prints it and its QR code carries:
 * `erplibre-ntfy:setup?v=1&url=<phone URL>&token=<tk_…>&prefix=<up…>&cache=<seconds>[&odoo=<Odoo-side URL>]`,
 * values percent-encoded.
 */
export interface NtfyLink {
  /** The ntfy server as the phone reaches it, without a trailing slash. */
  url: string;
  /** The access token, read-only on the prefix's topics. */
  token: string;
  /** "up" and 8 of [a-z0-9]: every topic of this phone on this server starts with it. */
  prefix: string;
  /** How long the server keeps a message (its cache-duration), in seconds. */
  cacheSeconds: number;
  /** The ntfy server as Odoo reaches it, when it differs from url; null for the same. */
  odooUrl: string | null;
}

const SCHEME = "erplibre-ntfy:setup?";
const TOKEN = /^tk_[A-Za-z0-9]+$/;
const PREFIX = /^up[a-z0-9]{8}$/;
const CACHE_MIN = 60;
const CACHE_MAX = 604800;

/** An http(s) URL, trimmed and without its trailing slashes, or null for anything else. */
export function httpUrl(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/?#]+/i.test(trimmed)) return null;
  try {
    new URL(trimmed);
  } catch {
    return null;
  }
  return trimmed;
}

/**
 * The link's fields, or null unless every one is valid: the scheme and
 * `v=1`, `url` (and `odoo` when present) http or https, `token` `tk_`
 * then letters and digits, `prefix` `up` then 8 of [a-z0-9], `cache` an
 * integer from 60 to 604800. Surrounding whitespace is ignored.
 */
export function parseNtfyLink(text: string): NtfyLink | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(SCHEME)) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(trimmed.slice(SCHEME.length));
  } catch {
    return null;
  }
  if (params.get("v") !== "1") return null;
  const url = httpUrl(params.get("url"));
  const token = params.get("token") ?? "";
  const prefix = params.get("prefix") ?? "";
  const cache = params.get("cache") ?? "";
  const odoo = params.get("odoo");
  const odooUrl = odoo === null ? null : httpUrl(odoo);
  if (!url || !TOKEN.test(token) || !PREFIX.test(prefix) || !/^\d+$/.test(cache)) return null;
  if (odoo !== null && odooUrl === null) return null;
  const cacheSeconds = Number(cache);
  if (cacheSeconds < CACHE_MIN || cacheSeconds > CACHE_MAX) return null;
  return { url, token, prefix, cacheSeconds, odooUrl };
}
