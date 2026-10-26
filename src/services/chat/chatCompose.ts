import type { EmojiConversion } from "./chatEmoji";

/**
 * The message HTML the browser composer of Odoo 18 posts, rebuilt from the
 * text of the composer: `prettifyMessageContent` of
 * `mail/static/src/utils/common/format.js`, step by step, on strings only
 * (it runs in the outbox, without a DOM). The goldens of
 * `src/__tests__/fixtures/composer-golden.json`, produced by Odoo's own
 * function in a browser, pin the output byte for byte.
 */

/** The people and channels picked in the composer, by their name at the pick. */
export interface Mentions {
  partners: { id: number; name: string }[];
  channels: { id: number; name: string; parentName: string | null }[];
}

/** No pick: the text's `@everyone` still links. Shared, so never mutated (validMentions filters into new arrays). */
export const EMPTY_MENTIONS: Mentions = { partners: [], channels: [] };

/** The special mentions of a channel (`store_service.js` `specialMentions`). */
const SPECIAL = ["everyone"];

/** Odoo's `escape` (`web/core/utils/strings.js`): six characters, the quotes and the backtick included. */
function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&#x27;")
    .replaceAll('"', "&quot;")
    .replaceAll("`", "&#x60;");
}

/** The inverse of escape, for the text the escaped body holds between its tags. */
function unescape(html: string): string {
  return html.replace(/&(amp|lt|gt|#x27|quot|#x60);/g, (_m, name: string) =>
    ({ amp: "&", lt: "<", gt: ">", "#x27": "'", quot: '"', "#x60": "`" })[name]!);
}

/** A text node as `outerHTML` writes it: `&`, the no-break space, `<` and `>`, quotes left as they are. */
function serializeText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("\u00a0", "&nbsp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function channelText(c: Mentions["channels"][number]): string {
  return c.parentName ? `#${c.parentName} > ${c.name}` : `#${c.name}`;
}

/**
 * The picks whose text is still in the raw text (`getMentionsFromText`,
 * `store_service.js:506-526`): `@name`, `#name` or `#parent > name`; a pick
 * whose text was edited away is dropped. A pick whose id is not an integer
 * is dropped too, so no id reaches an href, a `data-oe-id` or `partner_ids`
 * unchecked. `special` holds « everyone » when `@everyone` is in the text,
 * whoever was picked.
 */
export function validMentions(text: string, m: Mentions): Mentions & { special: string[] } {
  return {
    partners: m.partners.filter((p) => Number.isInteger(p.id) && text.includes(`@${p.name}`)),
    channels: m.channels.filter((c) => Number.isInteger(c.id) && text.includes(channelText(c))),
    special: SPECIAL.filter((s) => text.includes(`@${s}`)),
  };
}

/**
 * `escapeAndCompactTextContent` then the `&nbsp;` undo and the trim of
 * `prettifyMessageContent`: escaped, trimmed, a run of two line ends or
 * more as two breaks (a CRLF counts as two), any other line end as one.
 */
function escapeAndCompact(text: string): string {
  let value = escape(text).trim();
  value = value.replace(/(\r|\n){2,}/g, "<br/><br/>");
  value = value.replace(/(\r|\n)/g, "<br/>");
  value = value.replace(/ /g, "&nbsp;");
  value = value.replace(/([^>])&nbsp;([^<])/g, "$1 $2");
  value = value.replace(/&nbsp;/g, " ");
  return value.trim();
}

/**
 * `generateMentionsLinks` (`format.js:166-221`). Each mention's escaped text
 * becomes a placeholder, longest text first, and only at its FIRST place (a
 * string search); then `@everyone`, first place too; then each placeholder
 * becomes its anchor, attributes in the order `setAttributes` writes them
 * and the text as `outerHTML` serialises it. The replacements are
 * `String.replace` strings, `$` patterns included, as in the browser.
 */
function mentionLinks(body: string, valid: Mentions & { special: string[] }): string {
  const mentions = [
    ...valid.partners.map((p) => ({
      cls: "o_mail_redirect", id: p.id, model: "res.partner", placeholder: `@-mention-partner-${p.id}!`, text: `@${p.name}`,
    })),
    ...valid.channels.map((c) => ({
      cls: c.parentName ? "o_channel_redirect o_channel_redirect_asThread" : "o_channel_redirect",
      id: c.id, model: "discuss.channel", placeholder: `#-mention-channel-${c.id}!`, text: channelText(c),
    })),
  ].sort((a, b) => b.text.length - a.text.length);
  for (const m of mentions) body = body.replace(escape(m.text), escape(m.placeholder));
  for (const s of valid.special) {
    body = body.replace(escape(`@${s}`), `<a href="#" class="o-discuss-mention">@${escape(s)}</a>`);
  }
  for (const m of mentions) {
    const link = `<a href="/odoo/${m.model}/${m.id}" class="${m.cls}" data-oe-id="${m.id}" data-oe-model="${m.model}"`
      + ` target="_blank" contenteditable="false">${serializeText(m.text)}</a>`;
    body = body.replace(escape(m.placeholder), link);
  }
  return body;
}

/** Compiled emoji patterns by source, shared by every call. */
const EMOJI_PATTERNS = new Map<string, RegExp>();

/**
 * `_generateEmojisOnHtml` (`format.js:228-238`): each source, escaped, turned
 * into its emoji where whitespace or the start comes before it and
 * whitespace or the end after it. A `<br>` is neither, so `:)` before a line
 * break stays as typed, as in the browser.
 */
function emojis(body: string, conversions: EmojiConversion[]): string {
  for (const { source, codepoints } of conversions) {
    let pattern = EMOJI_PATTERNS.get(source);
    if (!pattern) {
      const quoted = escape(source).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      pattern = new RegExp("(\\s|^)(" + quoted + ")(?=\\s|$)", "g");
      EMOJI_PATTERNS.set(source, pattern);
    }
    body = body.replace(pattern, "$1" + escape(codepoints));
  }
  return body;
}

// format.js:16-17, verbatim
const URL_RE =
    /\b(?:https?:\/\/\d{1,3}(?:\.\d{1,3}){3}|(?:https?:\/\/|(?:www\.))[-a-z0-9@:%._+~#=À-ɏḀ-ỿ]{1,256}\.[a-z]{2,13})\b(?:[-a-z0-9@:%_+~#?&[\]^|{}`\\'$//=À-ɏḀ-ỿ]|[.]*[-a-z0-9@:%_+~#?&[\]^|{}`\\'$//=À-ɏḀ-ỿ]|,(?!$| )|\.(?!$| |\.)|;(?!$| ))*/gi;

/** The WHATWG form of a URL, or null when it does not parse (`URL.canParse` and `URL.parse`, which older web views lack). */
function normalisedHref(url: string): string | null {
  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}

/**
 * `linkify` (`format.js:93-113`) of one plain text: escaped, each URL of
 * URL_RE as `<a target="_blank" rel="noreferrer noopener" href>` with the
 * normalised href (`http://` before a bare `www.`) and the URL as typed for
 * text. A match that does not parse stays text.
 */
export function linkify(text: string): string {
  const pattern = new RegExp(URL_RE);
  let result = "";
  let current = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const url = match[0];
    const href = normalisedHref(/^https?:\/\//i.test(url) ? url : `http://${url}`);
    if (href === null) continue;
    result += escape(text.slice(current, match.index));
    result += `<a target="_blank" rel="noreferrer noopener" href="${escape(href)}">${escape(url)}</a>`;
    current = match.index + url.length;
  }
  return result + escape(text.slice(current));
}

/**
 * The tags mentionLinks and escapeAndCompact write: `<br/>`, and an anchor
 * whose text has no `<` (serializeText escapes it). A replacement pattern
 * such as `$'` inside a name inserts raw body text into an anchor; the
 * match then differs from the browser's parse, a case left unhandled.
 */
const TAG_RE = /<br\/>|<a [^>]*>[^<]*<\/a>/g;

/**
 * `parseAndTransform(body, addLink)`: the browser parses the body, links the
 * URLs of its text nodes, and writes every element back through
 * `outerHTML`. The body is built here, so its parts are known: escaped text,
 * `<br/>` (written `<br>`), and anchors, whose `outerHTML` is the text they
 * were built with (TAG_RE says where that stops holding).
 */
function linkifyHtml(body: string): string {
  let out = "";
  let current = 0;
  for (const tag of body.matchAll(TAG_RE)) {
    out += linkify(unescape(body.slice(current, tag.index)));
    out += tag[0] === "<br/>" ? "<br>" : tag[0];
    current = tag.index + tag[0].length;
  }
  return out + linkify(unescape(body.slice(current)));
}

/**
 * The body the browser posts for `text`, and the post's `partner_ids` and
 * `special_mentions`: the picks of `m` still in the text (validMentions),
 * `conversions` the shortcodes and emoticons (`emojiConversions()`).
 */
export function composeBody(
  text: string,
  m: Mentions,
  conversions: EmojiConversion[],
): { body: string; partnerIds: number[]; specialMentions: string[] } {
  const valid = validMentions(text, m);
  let body = escapeAndCompact(text);
  body = mentionLinks(body, valid);
  body = emojis(body, conversions);
  body = linkifyHtml(body);
  return { body, partnerIds: valid.partners.map((p) => p.id), specialMentions: valid.special };
}
