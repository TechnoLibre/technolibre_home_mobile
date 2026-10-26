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

/** The class of the empty span Odoo appends to an edited body (`mail_thread.py` `_message_update_content`). */
export const EDITED_CLASS = "o-mail-Message-edited";

/**
 * The anchors shown as chips: the class of a received anchor, the model its
 * `data-oe-model` must name (null: none read), and the class given.
 */
const CHIPS: { from: string; model: string | null; to: string }[] = [
  { from: "o_mail_redirect", model: "res.partner", to: "chat-msg__mention" },
  { from: "o_channel_redirect", model: "discuss.channel", to: "chat-msg__channel" },
  { from: "o-discuss-mention", model: null, to: "chat-msg__special" },
];

/**
 * The links of the notification Odoo posts when a message is pinned
 * (`discuss_channel.py` set_message_pin), by their `data-oe-type`: the
 * pinned message (`highlight`, its id in `data-oe-id`) and the list of the
 * channel's pinned messages (`pin-menu`). Their href is "#": the thread's
 * click delegation acts on the class given.
 */
const PIN_LINKS: Record<string, { to: string; id: boolean }> = {
  highlight: { to: "chat-msg__pin-jump", id: true },
  "pin-menu": { to: "chat-msg__pin-menu", id: false },
};

export interface RenderOptions {
  /** The text of the edited mark, « (modifié) »; without it the mark is not shown. */
  editedLabel?: string;
  /** The user's partner: a mention of it gets `chat-msg__mention--self`. */
  selfPartnerId?: number | null;
}

/**
 * The attributes of a kept anchor: an `href` that safeHref keeps (with the
 * target and rel set here; a relative or `#` href is dropped), and, for a
 * chip of CHIPS, its class with `data-oe-id` (digits only) and
 * `data-oe-model` (the chip's own model only); a pin link of PIN_LINKS, its
 * class with `data-oe-type` and, for the message it names, `data-oe-id`
 * (digits only). An anchor whose model or id fails stays a plain anchor: no
 * chip class, no `data-oe-*`.
 */
function copyAnchor(el: Element, copy: Element, opts: RenderOptions): void {
  const href = safeHref(el.getAttribute("href") ?? "");
  if (href !== null) {
    copy.setAttribute("href", href);
    copy.setAttribute("target", "_blank");
    copy.setAttribute("rel", "noreferrer noopener");
  }
  const type = el.getAttribute("data-oe-type") ?? "";
  const pin = Object.prototype.hasOwnProperty.call(PIN_LINKS, type) ? PIN_LINKS[type] : null;
  if (pin) {
    const pinId = el.getAttribute("data-oe-id") ?? "";
    if (pin.id && !/^\d+$/.test(pinId)) return;
    copy.setAttribute("class", pin.to);
    copy.setAttribute("data-oe-type", type);
    if (pin.id) copy.setAttribute("data-oe-id", pinId);
    return;
  }
  const chip = CHIPS.find((c) => el.classList.contains(c.from));
  if (!chip) return;
  if (chip.model === null) {
    copy.setAttribute("class", chip.to);
    return;
  }
  const id = el.getAttribute("data-oe-id") ?? "";
  if (el.getAttribute("data-oe-model") !== chip.model || !/^\d+$/.test(id)) return;
  const self = chip.model === "res.partner" && opts.selfPartnerId != null && Number(id) === opts.selfPartnerId;
  copy.setAttribute("class", self ? `${chip.to} ${chip.to}--self` : chip.to);
  copy.setAttribute("data-oe-id", id);
  copy.setAttribute("data-oe-model", chip.model);
}

/**
 * Rebuilds a received HTML body from a whitelist: only the tags of KEEP,
 * anchors as copyAnchor keeps them, images as a placeholder span, the
 * edited span as `<em class="chat-msg__edited"> label</em>` where it was
 * (`message.xml` `mail.Message.edited`). Scripts, styles, frames, comments,
 * event handlers and every other attribute never reach the output. Unknown
 * tags keep their text.
 */
export function renderBody(html: string, opts: RenderOptions = {}): string {
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
      if (el.classList.contains(EDITED_CLASS)) {
        if (opts.editedLabel) {
          const em = out.createElement("em");
          em.setAttribute("class", "chat-msg__edited");
          em.textContent = " " + opts.editedLabel;
          into.appendChild(em);
        }
      } else if (tag === "img") {
        const span = out.createElement("span");
        span.setAttribute("class", "chat-msg__image");
        span.textContent = IMAGE_PLACEHOLDER;
        into.appendChild(span);
      } else if (DROP.has(tag)) {
        continue;
      } else if (KEEP.has(tag)) {
        const copy = out.createElement(tag);
        if (tag === "a") copyAnchor(el, copy, opts);
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

/**
 * The text of a body as the browser puts it back in its composer to edit it
 * (`convertBrToLineBreak`, `format.js:260-263`): each `<br>` a line end, then
 * the text content, so a mention reads `@Name`, a link its typed text, and
 * the marker comment and the edited span nothing. Copy uses it too.
 */
export function bodyText(html: string): string {
  return parseBody(html.replace(/<br\s*\/?>/gi, "\n")).body.textContent ?? "";
}

/**
 * Text lowered and stripped of its accents (NFD, combining marks removed;
 * Odoo's `cleanTerm`): the form names, terms and message texts are
 * compared in, so « Élan » and « elan » match.
 */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The client marker as text (`erplibre-mobile:<uuid>`, outboxMarker.ts), which a record's chatter post shows in a `<small>`. */
const MARKER_TEXT = /erplibre-mobile:[0-9A-Za-z-]*/g;

/**
 * The text of a body that search reads and quotes: bodyText without the
 * client markers, so the marker comment, the marker text of a chatter post
 * and the edited span read as nothing and a mention as its `@Name`.
 */
export function searchableText(body: string): string {
  return bodyText(body).replace(MARKER_TEXT, "");
}

/** The searchable text of a body (chat_messages.search_text): searchableText folded by foldText. */
export function searchTextOf(body: string): string {
  return foldText(searchableText(body));
}

/** True when the body carries Odoo's edited span. */
export function isEdited(body: string): boolean {
  return parseBody(body).querySelector("." + EDITED_CLASS) !== null;
}

/** The bodies the browser takes for empty once the edited span and every whitespace are removed. */
const EMPTY_FORMS = new Set(["", "<p></p>", "<p><br></p>", "<p><br/></p>", "<div></div>", "<div><br></div>", "<div><br/></div>"]);

/** `isBodyEmpty` of `message_model.js:364-382`, on the body as stored. */
export function isEmptyBody(body: string): boolean {
  return !body || EMPTY_FORMS.has(body.replace(`<span class="${EDITED_CLASS}"></span>`, "").replace(/\s/g, ""));
}

/**
 * A message the thread hides, as the browser does for a deleted one: an
 * empty body and no file. An emptied body that still has a file stays.
 */
export function isEmptyMessage(body: string, attachmentCount: number): boolean {
  return isEmptyBody(body) && attachmentCount === 0;
}

/** The optimistic body of a queued edit: the new body with the edited span the server will add. */
export function withEditedMark(body: string): string {
  return body + `<span class="${EDITED_CLASS}"></span>`;
}

/**
 * The partners and channels a body links, in body order, each once: the
 * anchors the browser reads back to edit a message (`a.o_mail_redirect` of
 * `res.partner`, `.o_channel_redirect` of `discuss.channel`), digit ids only.
 */
export function mentionAnchors(html: string): { partners: number[]; channels: number[] } {
  const doc = parseBody(html);
  const ids = (selector: string): number[] => [
    ...new Set(
      Array.from(doc.querySelectorAll(selector))
        .map((el) => el.getAttribute("data-oe-id") ?? "")
        .filter((id) => /^\d+$/.test(id))
        .map(Number),
    ),
  ];
  return {
    partners: ids('a.o_mail_redirect[data-oe-model="res.partner"]'),
    channels: ids('.o_channel_redirect[data-oe-model="discuss.channel"]'),
  };
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
