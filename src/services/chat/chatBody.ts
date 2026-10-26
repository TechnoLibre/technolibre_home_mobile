import { t } from "../../i18n";

/** Tags of a received body that are kept; every other tag is unwrapped or dropped. */
const KEEP = new Set([
  "p", "br", "a", "span", "b", "strong", "i", "em", "u", "ul", "ol", "li", "blockquote", "code", "pre",
]);
/** Tags dropped with their whole content. */
const DROP = new Set([
  "script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math", "head", "title",
  "link", "meta", "base", "form", "input", "textarea", "select", "button", "audio", "video",
]);
/** Tags that end a line in a preview. */
const BLOCK = new Set(["p", "br", "li", "ul", "ol", "blockquote", "pre", "div", "tr"]);

const IMAGE_PLACEHOLDER = "🖼️";

/** The comment Odoo keeps in a body, which lets the client find its own post again. */
export function chatMarker(uuid: string): string {
  return "<!-- erplibre-mobile:" + uuid + " -->";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Runs on escaped text: a URL stops at whitespace, "<" or an escaped quote or bracket.
const URL_RE = /https?:\/\/(?:(?!&(?:quot|gt|lt|#39);)[^\s<])+/g;

/**
 * Plain text as the browser composer sends it: escaped, newlines as <br>,
 * http(s) URLs as links, then the marker of `markerUuid` when given. Text is
 * escaped before it is linked, so the href never holds a raw quote or bracket.
 */
export function textToBody(text: string, markerUuid: string | null): string {
  const linked = escapeHtml(text).replace(URL_RE, (match) => {
    const url = match.replace(/[.,;:!?)\]]+$/, "");
    const rest = match.slice(url.length);
    return `<a href="${url}" target="_blank" rel="noreferrer noopener">${url}</a>${rest}`;
  });
  return linked.replace(/\r\n|\r|\n/g, "<br>") + (markerUuid ? chatMarker(markerUuid) : "");
}

/** True when the body carries the marker of `uuid`. */
export function bodyHasMarker(body: string, uuid: string): boolean {
  return body.includes(chatMarker(uuid));
}

/** An href kept: http, https, mailto or tel only, after removing the whitespace and controls a browser ignores. */
function safeHref(value: string): string | null {
  // eslint-disable-next-line no-control-regex
  const compact = value.replace(/[\u0000- \u007f-\u009f]/g, "");
  return /^(https?:|mailto:|tel:)/i.test(compact) ? value.trim() : null;
}

function parseBody(html: string): Document {
  return new DOMParser().parseFromString("<body>" + html + "</body>", "text/html");
}

/**
 * Rebuilds a received HTML body from a whitelist: only the tags of KEEP, an
 * `href` on links (plus the target and rel set here), images as a placeholder
 * span. Scripts, styles, frames, comments, event handlers and every other
 * attribute never reach the output. Unknown tags keep their text.
 */
export function renderBody(html: string): string {
  const src = parseBody(html);
  const out = src.implementation.createHTMLDocument("");
  const walk = (from: Node, into: Node): void => {
    for (const node of Array.from(from.childNodes)) {
      if (node.nodeType === 3) {
        into.appendChild(out.createTextNode(node.textContent ?? ""));
        continue;
      }
      if (node.nodeType !== 1) continue;
      const el = node as Element;
      const tag = el.tagName.toLowerCase();
      if (tag === "img") {
        const span = out.createElement("span");
        span.setAttribute("class", "chat-msg__image");
        span.textContent = IMAGE_PLACEHOLDER;
        into.appendChild(span);
      } else if (DROP.has(tag)) {
        continue;
      } else if (KEEP.has(tag)) {
        const copy = out.createElement(tag);
        if (tag === "a") {
          const href = safeHref(el.getAttribute("href") ?? "");
          if (href !== null) {
            copy.setAttribute("href", href);
            copy.setAttribute("target", "_blank");
            copy.setAttribute("rel", "noreferrer noopener");
          }
        }
        walk(el, copy);
        into.appendChild(copy);
      } else {
        walk(el, into);
      }
    }
  };
  walk(src.body, out.body);
  return out.body.innerHTML;
}

/** The body as one line of text for a conversation list, cut to `max` characters with an ellipsis. */
export function bodyPreview(html: string, max = 80): string {
  const parts: string[] = [];
  const walk = (from: Node): void => {
    for (const node of Array.from(from.childNodes)) {
      if (node.nodeType === 3) {
        parts.push(node.textContent ?? "");
      } else if (node.nodeType === 1) {
        const tag = (node as Element).tagName.toLowerCase();
        if (DROP.has(tag)) continue;
        if (tag === "img") parts.push(" " + IMAGE_PLACEHOLDER + " ");
        if (BLOCK.has(tag)) parts.push(" ");
        walk(node);
        if (BLOCK.has(tag)) parts.push(" ");
      }
    }
  };
  walk(parseBody(html).body);
  const text = parts.join("").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, Math.max(0, max - 1)).trimEnd() + "…" : text;
}

/** Mimetypes the web view shows as an image, as Odoo's attachment list does (TIFF and HEIC open as files). */
const IMAGE_TYPES = new Set([
  "image/bmp", "image/gif", "image/jpeg", "image/png", "image/svg+xml", "image/webp", "image/x-icon",
]);

export type AttachmentKind = "image" | "voice" | "file";

/**
 * How a file of a message is shown, in the thread as in the list: an image
 * the web view shows, a voice message or other audio (the player), else a
 * file opened with another app.
 */
export function attachmentKind(a: { mimetype: string; voice: boolean }): AttachmentKind {
  const type = (a.mimetype || "").toLowerCase();
  if (IMAGE_TYPES.has(type)) return "image";
  if (a.voice || type.startsWith("audio/")) return "voice";
  return "file";
}

const ICONS: Record<AttachmentKind, string> = { image: "🖼️", voice: "🎤", file: "📎" };

/**
 * The list line of a conversation's draft: « Draft: » then its text on one
 * line, cut at `max` characters with an ellipsis, or 📎 and its number of
 * files when it has no text.
 */
export function draftPreview(text: string, files: number, max = 80): string {
  const line = text.replace(/\s+/g, " ").trim();
  const shown = line ? (line.length > max ? line.slice(0, Math.max(0, max - 1)).trimEnd() + "…" : line) : "📎 " + files;
  return t("chat.draft_preview", { text: shown });
}

/**
 * The files of a message as one line of a conversation list, by
 * attachmentKind: 🎤 and « voice message » for a voice message, the icon
 * of its kind before any other file's name; cut to `max` characters.
 */
export function attachmentPreview(atts: { name: string; mimetype: string; voice: boolean }[], max = 80): string {
  const text = atts
    .map((a) => ICONS[attachmentKind(a)] + " " + (a.voice ? t("chat.voice_message") : a.name))
    .join(", ");
  return text.length > max ? text.slice(0, Math.max(0, max - 1)).trimEnd() + "…" : text;
}
