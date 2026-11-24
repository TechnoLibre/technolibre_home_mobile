import type { ChatChannel } from "../../models/chat";
import { t } from "../../i18n";
import { RequestNotSentError, type OdooRpcClient } from "../odoo/odooRpcClient";
import type { Mentions } from "./chatCompose";
import type { ChatPeople } from "./chatPeople";
import type { ChatRepository } from "./chatRepository";
import type { ChatSource } from "./chatSources";
import { foldText as fold } from "./chatBody";
import { parseStore } from "./chatStore";

/**
 * The composer's @ and # suggestions, as Odoo 18's browser composer makes
 * them (`mail/static/src/core/common/suggestion_service.js`): the query
 * under the caret, the people and channels it matches, and the picks of a
 * text tracked by place until they are sent.
 */

/** People or channels a list shows at most, @everyone aside: the server's own limit. */
export const SUGGESTION_LIMIT = 8;

/** The special mention « everyone » needs this many typed characters (`suggestion_service.js:207-216`). */
const SPECIAL_MIN_CHARS = 4;
const EVERYONE = "everyone";

/** The @ or # word the caret ends: its delimiter, the text typed after it, and where the delimiter is. */
export interface MentionQuery {
  kind: "@" | "#";
  term: string;
  start: number;
}

/**
 * The query the caret ends, or null: the characters between the last
 * whitespace (or the start) and the caret, when they begin with `@` or `#`.
 * A delimiter inside a word (`mail@x`) or with whitespace between it and
 * the caret is no query; `@` alone is one, with an empty term.
 */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const end = Math.max(0, Math.min(caret, text.length));
  let start = end;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  const kind = text[start];
  if (start === end || (kind !== "@" && kind !== "#")) return null;
  return { kind, term: text.slice(start + 1, end), start };
}

export type Suggestion =
  | { kind: "partner"; id: number; name: string }
  | { kind: "channel"; id: number; name: string; parentName: string | null }
  | { kind: "special"; label: "everyone" };

/** The text a suggestion writes: `@Name`, `#Name`, `#Parent > Name` or `@everyone` (`format.js:166-206`). */
export function suggestionText(s: Suggestion): string {
  if (s.kind === "partner") return "@" + s.name;
  if (s.kind === "special") return "@" + s.label;
  return s.parentName ? "#" + s.parentName + " > " + s.name : "#" + s.name;
}

/**
 * A suggestion picked into a text: its text from `start`. A channel's
 * `parentName` (null or absent for a top channel) splits its text back
 * into names. A special one has id 0 and links from the text alone.
 */
export interface MentionPick {
  kind: "partner" | "channel" | "special";
  id: number;
  text: string;
  start: number;
  parentName?: string | null;
}

function pickOf(s: Suggestion, start: number): MentionPick {
  const text = suggestionText(s);
  if (s.kind === "channel") return { kind: "channel", id: s.id, text, start, parentName: s.parentName };
  return { kind: s.kind, id: s.kind === "partner" ? s.id : 0, text, start };
}

/**
 * `s` picked for the query `q` the caret ends: the query replaced by the
 * suggestion's text and a space, the caret after that space, and the pick.
 */
export function applySuggestion(
  text: string,
  q: MentionQuery,
  caret: number,
  s: Suggestion,
): { text: string; caret: number; pick: MentionPick } {
  const inserted = suggestionText(s) + " ";
  return {
    text: text.slice(0, q.start) + inserted + text.slice(caret),
    caret: q.start + inserted.length,
    pick: pickOf(s, q.start),
  };
}

/**
 * The picks of `before` once it became `after`. The change is the part
 * between the longest common start and the longest common end of both
 * texts. A pick wholly before it stays where it is, one wholly after it
 * moves by the change in length; a pick it touches inside, or whose text
 * is not whole at its new place, is dropped.
 */
export function adjustPicks(picks: MentionPick[], before: string, after: string): MentionPick[] {
  const shortest = Math.min(before.length, after.length);
  let head = 0;
  while (head < shortest && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < shortest - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const changedEnd = before.length - tail;
  const shift = after.length - before.length;
  const out: MentionPick[] = [];
  for (const p of picks) {
    const end = p.start + p.text.length;
    let start: number;
    if (end <= head) start = p.start;
    else if (p.start >= changedEnd) start = p.start + shift;
    else continue;
    if (after.slice(start, start + p.text.length) === p.text) out.push({ ...p, start });
  }
  return out;
}

/** The people and channels of the picks, each once by id and name; the special ones link from the text alone. */
export function picksToMentions(picks: MentionPick[]): Mentions {
  const m: Mentions = { partners: [], channels: [] };
  for (const p of picks) {
    if (p.kind === "partner") {
      const name = p.text.slice(1);
      if (!m.partners.some((x) => x.id === p.id && x.name === name)) m.partners.push({ id: p.id, name });
    } else if (p.kind === "channel") {
      const parentName = p.parentName || null;
      const name = parentName ? p.text.slice(parentName.length + 4) : p.text.slice(1);
      if (!m.channels.some((x) => x.id === p.id && x.name === name)) m.channels.push({ id: p.id, name, parentName });
    }
  }
  return m;
}

/**
 * Picks of `text` for the people and channels of `m`, each where its text
 * first is (the place composeBody links); one whose text is not there has
 * none. It places the picks of a text shown whole: a draft, an edit.
 */
export function picksOf(text: string, m: Mentions): MentionPick[] {
  const out: MentionPick[] = [];
  const place = (s: Suggestion) => {
    const start = text.indexOf(suggestionText(s));
    if (start >= 0) out.push(pickOf(s, start));
  };
  for (const p of m.partners) place({ kind: "partner", id: p.id, name: p.name });
  for (const c of m.channels) place({ kind: "channel", id: c.id, name: c.name, parentName: c.parentName });
  return out;
}

/**
 * Who a conversation's @ list offers (`suggestion_service.js:161-189`):
 * "members" in a chat or a group, only its members; "group" in a channel
 * with an access group (its parent's for a sub-channel), its members from
 * the cache, and whom the server gives (it limits them to the group);
 * "public" in a channel open to everyone, members, then anyone.
 */
type Scope = "members" | "group" | "public";

/**
 * The @ and # suggestions of a composer: a conversation's, or with a null
 * channel a reply's in a record's chatter. local() reads the cache only,
 * for the list shown at once; remote() asks the server and gives the
 * cache's suggestions and the server's together, or the cache's alone
 * offline, for a temporary conversation, or when the request never left
 * (RequestNotSentError); forRecord() is remote() of a record's chatter.
 * Other errors propagate. Nothing is written to the cache.
 */
export class ChatMentions {
  constructor(
    private repo: ChatRepository,
    private rpc: OdooRpcClient,
    private people: ChatPeople,
    private isOnline: () => Promise<boolean>,
  ) {}

  local(src: ChatSource, channel: ChatChannel | null, q: MentionQuery): Promise<Suggestion[]> {
    if (q.kind === "#") return this.channels(src.configId, q.term, []);
    return channel ? this.partners(src.configId, channel, q.term, null) : this.recordPartners(src.configId, q.term, null);
  }

  /**
   * `@`: `res.partner.get_mention_suggestions_from_channel`, a Store of the
   * matching members and users, or in a record's chatter
   * `res.partner.get_mention_suggestions`, a Store of the matching partners,
   * as the browser's chatter asks (`mail/models/res_partner.py`); `#`:
   * `discuss.channel.get_mention_suggestions`, the user's matching
   * channels. The term goes folded, as the browser sends it.
   */
  async remote(src: ChatSource, channel: ChatChannel | null, q: MentionQuery): Promise<Suggestion[]> {
    if ((channel && channel.channelId <= 0) || !(await this.isOnline())) return this.local(src, channel, q);
    const search = fold(q.term);
    try {
      if (q.kind === "@" && !channel) {
        const result = await this.rpc.callKw(src.creds, "res.partner", "get_mention_suggestions", [], {
          search, limit: SUGGESTION_LIMIT,
        });
        return await this.recordPartners(src.configId, q.term, result);
      }
      if (q.kind === "@" && channel) {
        const result = await this.rpc.callKw(src.creds, "res.partner", "get_mention_suggestions_from_channel", [], {
          channel_id: channel.channelId, search, limit: SUGGESTION_LIMIT,
        });
        return await this.partners(src.configId, channel, q.term, result);
      }
      const rows = await this.rpc.callKw(src.creds, "discuss.channel", "get_mention_suggestions", [], {
        search, limit: SUGGESTION_LIMIT,
      });
      return await this.channels(src.configId, q.term, Array.isArray(rows) ? rows : []);
    } catch (e) {
      if (e instanceof RequestNotSentError) return this.local(src, channel, q);
      throw e;
    }
  }

  /** The suggestions of a reply's composer in a record's chatter: remote() with no conversation. */
  forRecord(src: ChatSource, q: MentionQuery): Promise<Suggestion[]> {
    return this.remote(src, null, q);
  }

  /**
   * The people to offer in a record's chatter: the people cache's whose
   * name holds `term` (ChatPeople.searchCached, self left out), then the
   * server's answer (`store`, null for none), its partners kept as it
   * matched them, by name or email. A name that starts with the term
   * first, then by name and id; no special mention off a conversation.
   */
  private async recordPartners(configId: string, term: string, store: any): Promise<Suggestion[]> {
    const needle = fold(term);
    const found = new Map<number, string>();
    for (const p of await this.people.searchCached(configId, term, SUGGESTION_LIMIT)) found.set(p.partnerId, p.name);
    if (store) {
      const [state, cached] = await Promise.all([this.repo.sourceState(configId), this.repo.partners(configId)]);
      const names = new Map(cached.map((p) => [p.partnerId, p.name]));
      for (const p of parseStore(store, configId, state.selfPartnerId).partners) {
        const name = p.name ?? names.get(p.partnerId);
        if (name) found.set(p.partnerId, name);
      }
    }
    return [...found]
      .sort(([ia, a], [ib, b]) =>
        Number(fold(b).startsWith(needle)) - Number(fold(a).startsWith(needle)) ||
        fold(a).localeCompare(fold(b)) ||
        ia - ib)
      .slice(0, SUGGESTION_LIMIT)
      .map(([id, name]) => ({ kind: "partner", id, name }));
  }

  private async scopeOf(configId: string, channel: ChatChannel): Promise<Scope> {
    if (channel.channelType !== "channel") return "members";
    if (channel.parentChannelId === null) return channel.groupPublicId !== null ? "group" : "public";
    const parent = await this.repo.channel(configId, channel.parentChannelId);
    // A parent not cached has an access unknown: its sub-channel offers members only
    if (!parent) return "group";
    return parent.groupPublicId !== null ? "group" : "public";
  }

  /**
   * The people to offer: the cached members whose name holds `term`
   * (folded), the people cache in a public channel, then the server's
   * answer (`store`, null for none) as the scope lets it, a member of a
   * chat or a group being one in the cache or in the answer. The server's
   * partners are kept as it matched them, by name or email. Members first,
   * then a name that starts with the term, then by name and id. @everyone
   * last, when the term starts « everyone » or is in its description
   * (chat.suggest_everyone, the list's own text), as the browser matches it.
   */
  private async partners(configId: string, channel: ChatChannel, term: string, store: any): Promise<Suggestion[]> {
    const needle = fold(term);
    const [members, cached, state, scope] = await Promise.all([
      this.repo.members(configId, channel.channelId),
      this.repo.partners(configId),
      this.repo.sourceState(configId),
      this.scopeOf(configId, channel),
    ]);
    const names = new Map(cached.map((p) => [p.partnerId, p.name]));
    const memberIds = new Set(members.map((m) => m.partnerId));
    const found = new Map<number, { id: number; name: string }>();
    const add = (id: number, name: string | undefined, matched = false) => {
      if (name && (matched || fold(name).includes(needle))) found.set(id, { id, name });
    };
    for (const id of memberIds) add(id, names.get(id));
    if (scope === "public") {
      for (const p of await this.people.searchCached(configId, term, SUGGESTION_LIMIT)) {
        if (!found.has(p.partnerId)) add(p.partnerId, p.name);
      }
    }
    if (store) {
      const delta = parseStore(store, configId, state.selfPartnerId);
      for (const m of delta.members) {
        if (m.channelId === channel.channelId && typeof m.partnerId === "number") memberIds.add(m.partnerId);
      }
      for (const p of delta.partners) {
        if (scope === "members" && !memberIds.has(p.partnerId)) continue;
        // The server matched on the name or the email: kept as it matched
        add(p.partnerId, p.name ?? names.get(p.partnerId), true);
      }
    }
    const out: Suggestion[] = [...found.values()]
      .sort((a, b) =>
        Number(memberIds.has(b.id)) - Number(memberIds.has(a.id)) ||
        Number(fold(b.name).startsWith(needle)) - Number(fold(a.name).startsWith(needle)) ||
        fold(a.name).localeCompare(fold(b.name)) ||
        a.id - b.id)
      .slice(0, SUGGESTION_LIMIT)
      .map((c) => ({ kind: "partner", id: c.id, name: c.name }));
    const special = channel.channelType === "group" || channel.channelType === "channel";
    const everyone = EVERYONE.startsWith(needle) || fold(t("chat.suggest_everyone")).includes(needle);
    if (special && needle.length >= SPECIAL_MIN_CHARS && everyone) out.push({ kind: "special", label: EVERYONE });
    return out;
  }

  /**
   * The channels to offer: the cached ones of type channel the user is a
   * member of whose name holds `term` (folded), then the server's `rows`,
   * kept as it matched them. A
   * sub-channel is offered under its parent's name, so one whose parent
   * is not cached is left out; so is a channel still under a temporary id.
   * A name that starts with the term first, then by name and id.
   */
  private async channels(configId: string, term: string, rows: any[]): Promise<Suggestion[]> {
    const needle = fold(term);
    const all = await this.repo.channels(configId);
    const byId = new Map(all.map((c) => [c.channelId, c]));
    const found = new Map<number, Suggestion & { kind: "channel" }>();
    const add = (id: number, name: string, parentId: number | null, matched = false) => {
      if (id <= 0 || !name || found.has(id) || !(matched || fold(name).includes(needle))) return;
      const parentName = parentId === null ? null : byId.get(parentId)?.name || null;
      if (parentId !== null && !parentName) return;
      found.set(id, { kind: "channel", id, name, parentName });
    };
    for (const c of all) {
      if (c.channelType === "channel" && c.isMember) add(c.channelId, c.name, c.parentChannelId);
    }
    for (const r of rows) {
      if (typeof r?.id !== "number" || r.channel_type !== "channel" || typeof r.name !== "string") continue;
      const parent = r.parent_channel_id && typeof r.parent_channel_id.id === "number" ? r.parent_channel_id.id : null;
      add(r.id, r.name, parent, true);
    }
    return [...found.values()]
      .sort((a, b) =>
        Number(fold(b.name).startsWith(needle)) - Number(fold(a.name).startsWith(needle)) ||
        fold(a.name).localeCompare(fold(b.name)) ||
        a.id - b.id)
      .slice(0, SUGGESTION_LIMIT);
  }
}
