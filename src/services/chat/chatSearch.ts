import { getCurrentLocale } from "../../i18n";
import type { ChatChannel, ChatMailboxItem, ChatMessage, ChatPartner } from "../../models/chat";
import { RequestNotSentError, type OdooRpcClient } from "../odoo/odooRpcClient";
import { foldText, searchableText } from "./chatBody";
import { displayNameOf } from "./chatNames";
import type { ChatPeople, JoinableChannel } from "./chatPeople";
import type { ChatRepository } from "./chatRepository";
import type { ChatSource } from "./chatSources";
import { parseStore, type StoreDelta } from "./chatStore";

/** The fewest characters, folded and trimmed, a term needs before it is searched. */
export const SEARCH_MIN = 2;

/** The most people the cache gives for one account. */
const PEOPLE_MAX = 10;

/** The module's search over the user's member channels (module 1.4). */
export const MODULE_SEARCH_ROUTE = "/erplibre_mobile_chat/message/search";

/** Messages one server page asks for. */
export const SERVER_PAGE = 30;

/** The most people and channels to join one server answer adds. */
const SERVER_NAMES_MAX = 10;

/** The words of a term, folded (foldText), in order: what likePattern joins by `%`. */
export function termWords(term: string): string[] {
  return foldText(term).split(/ +/).filter(Boolean);
}

/** Whether a term is long enough to search: SEARCH_MIN characters or more once folded and trimmed. */
export function isSearchTerm(term: string): boolean {
  return Array.from(foldText(term).trim()).length >= SEARCH_MIN;
}

/** Text made literal in a LIKE whose escape is `\`: a backslash before `\`, `%` and `_`. */
export function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => "\\" + c);
}

/**
 * A term as Odoo's `ilike` takes it for a name or a subject: `\`, `%` and
 * `_` made literal (likeEscape), then each space a `%`, as
 * `_message_fetch` does so the spacing need not be exact.
 */
export function rawTerm(term: string): string {
  return likeEscape(term).replace(/ /g, "%");
}

/**
 * A term as Odoo's `ilike` takes it for a stored HTML body: the sanitizer
 * writes only `&`, `<` and `>` as entities (`&` first, so the entities
 * made are not written again), then rawTerm. Apostrophes, quotes and
 * accents stay as typed, as they are stored.
 */
export function htmlTerm(term: string): string {
  return rawTerm(term.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
}

/**
 * The LIKE pattern of a term over a folded text (search_text): the folded
 * term escaped, each run of spaces a `%`, inside `%…%`. It matches a text
 * that holds the words of the term in order, anything between them.
 */
export function likePattern(term: string): string {
  return "%" + likeEscape(foldText(term)).replace(/ +/g, "%") + "%";
}

/**
 * likePattern in JS over a folded text: the words of the term found in
 * order, each after the end of the one before. The earliest place of each
 * word is taken, so a text matches exactly when the LIKE matches it. A
 * term without a word matches nothing.
 */
export function matchesTerm(searchText: string, term: string): boolean {
  const words = termWords(term);
  if (words.length === 0) return false;
  let from = 0;
  for (const w of words) {
    const at = searchText.indexOf(w, from);
    if (at < 0) return false;
    from = at + w.length;
  }
  return true;
}

/**
 * A text folded one character at a time, with where each unit of the
 * folded string comes from: `at[i]` is the index, in `chars`, of the
 * character that gave the folded unit `i`. A match found in the folded
 * string is cut from the original text through it.
 */
function foldedMap(text: string): { chars: string[]; folded: string; at: number[] } {
  const chars = Array.from(text);
  let folded = "";
  const at: number[] = [];
  chars.forEach((c, i) => {
    const f = foldText(c);
    folded += f;
    for (let k = 0; k < f.length; k++) at.push(i);
  });
  return { chars, folded, at };
}

/**
 * The text on one line around the first match of the term (its first
 * word), at most `max` characters with the `…` that mark a cut end. The
 * match sits a quarter of the way in; a text without a match is cut from
 * its start.
 */
export function snippetOf(text: string, term: string, max = 80): string {
  const line = text.replace(/\s+/g, " ").trim();
  const { chars, folded, at } = foldedMap(line);
  if (chars.length <= max) return line;
  const first = termWords(term)[0];
  const hit = first ? folded.indexOf(first) : -1;
  const start = hit < 0 ? 0 : at[hit];
  const begin = Math.max(0, Math.min(start - Math.floor(max / 4), chars.length - max));
  if (begin === 0) return chars.slice(0, max - 1).join("") + "…";
  if (begin === chars.length - max) return "…" + chars.slice(begin + 1).join("");
  return "…" + chars.slice(begin + 1, begin + max - 1).join("") + "…";
}

/** A piece of a shown text; `mark` when it is a word of the term. */
export interface MarkPart {
  text: string;
  mark: boolean;
}

/**
 * The text cut into pieces, each place of each word of the term (accents
 * and case ignored) a marked piece, overlapping places merged. The view
 * renders the pieces as text nodes, the marked ones in `<mark>`.
 */
export function markParts(text: string, term: string): MarkPart[] {
  const { chars, folded, at } = foldedMap(text);
  const ranges: [number, number][] = [];
  for (const w of termWords(term)) {
    for (let i = folded.indexOf(w); i >= 0; i = folded.indexOf(w, i + w.length)) {
      ranges.push([at[i], at[i + w.length - 1] + 1]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const parts: MarkPart[] = [];
  let pos = 0;
  for (const [s, e] of ranges) {
    if (e <= pos) continue;
    const from = Math.max(s, pos);
    if (from > pos) parts.push({ text: chars.slice(pos, from).join(""), mark: false });
    parts.push({ text: chars.slice(from, e).join(""), mark: true });
    pos = e;
  }
  if (pos < chars.length) parts.push({ text: chars.slice(pos).join(""), mark: false });
  return parts;
}

/**
 * A message found: on the phone (origin "phone") or by the server. A queued
 * post has no message id, only its client uuid. `fileName` is set for a
 * file found by its name; `snippet` is the text quoted around the match.
 */
export interface SearchHit {
  configId: string;
  channelId: number;
  messageId: number | null;
  clientUuid: string | null;
  authorPartnerId: number | null;
  date: string;
  snippet: string;
  fileName: string | null;
  origin: "phone" | "server";
}

/** What a search finds, by section; each list in the order shown. */
export interface SearchResults {
  conversations: { configId: string; channelId: number }[];
  people: { configId: string; partner: ChatPartner }[];
  joinable: { configId: string; channel: JoinableChannel }[];
  messages: SearchHit[];
  files: SearchHit[];
  mailbox: { item: ChatMailboxItem; snippet: string }[];
}

export function emptyResults(): SearchResults {
  return { conversations: [], people: [], joinable: [], messages: [], files: [], mailbox: [] };
}

const newestFirst = (a: SearchHit, b: SearchHit): number => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);

/**
 * The hits of the phone and of the server as one list: one hit per
 * (account, message id), the phone's kept over the server's, a queued post
 * (no id) always kept; newest first, a stable sort, so hits of one date
 * keep the phone's then the server's order.
 */
export function mergeHits(local: SearchHit[], server: SearchHit[]): SearchHit[] {
  const seen = new Set(local.filter((h) => h.messageId !== null).map((h) => `${h.configId}#${h.messageId}`));
  const out = [...local];
  for (const h of server) {
    const k = `${h.configId}#${h.messageId}`;
    if (h.messageId !== null && seen.has(k)) continue;
    if (h.messageId !== null) seen.add(k);
    out.push(h);
  }
  return out.sort(newestFirst);
}

/** What one account's server finds for a term: one page of messages, and the names on the first page. */
export interface ServerResults {
  /** Newest first; a hit by a file's name has its `fileName`. */
  hits: SearchHit[];
  joinable: JoinableChannel[];
  people: ChatPartner[];
  /** Every match on the server, whatever the page; null when not asked. An upper bound once `dropped` is above 0. */
  count: number | null;
  /** The page as the server answered it brought messages, fewer than `count`: a next page (before `oldestId`) may hold more. */
  more: boolean;
  /** The smallest id of the page as the server answered it, before the filter; null for an empty page. */
  oldestId: number | null;
  /** The messages of the page as the server answered it, before the filter. */
  scanned: number;
  /** The messages of the page left out of `hits`: the term is only in their markup (the client marker, a link's address). */
  dropped: number;
  /** Not asked: no network, or the request never left. */
  offline: boolean;
}

/** One server message as the search reads it, from the module's Store or from search_read. */
interface ServerMessage {
  messageId: number;
  channelId: number;
  body: string;
  date: string;
  authorPartnerId: number | null;
  fileNames: string[];
  subject: string;
}

/** One server page as the search reads it: its messages, the ids the server listed, the server's count. */
interface ServerPage {
  messages: ServerMessage[];
  ids: number[];
  count: number;
}

/** A route the server answered with a plain 404 (no JSON-RPC answer): the module is gone or older. */
class RouteMissingError extends Error {}

/** A delta carrying only partner records. */
const partnersOnly = (partners: StoreDelta["partners"], selfPartnerId: number | null): StoreDelta => ({
  channels: [], deletedChannelIds: [], members: [], deletedMemberIds: [], messages: [], attachments: [],
  deletedAttachmentIds: [], partners, inboxCounter: null, selfPartnerId,
});

/**
 * Search over the chat of the phone and of the servers. local() reads the
 * cache only, so it answers offline; server() asks one account's server
 * for a page. Neither marks anything read.
 */
export class ChatSearch {
  /** The conversations of the accounts as the list shows them; ChatService gives its own. */
  conversations: (configIds: string[]) => Promise<ChatChannel[]> = async () => [];

  /** Called when the module's route answers 404, so the module state is probed again; ChatService gives its own. */
  moduleRefused: (configId: string) => Promise<void> = async () => {};

  constructor(
    readonly repo: ChatRepository,
    readonly people: ChatPeople,
    readonly rpc: OdooRpcClient,
    readonly features: (configId: string) => Promise<{ serverSearch: boolean }>,
    readonly isOnline: () => Promise<boolean>,
  ) {}

  /**
   * The cache's answer to a term, for each account: the conversations
   * whose display name holds it, the cached people (searchCached), the
   * messages whose text holds it (a failed post left out), the files by
   * name, each a hit on its message, and the inbox, history and starred
   * items by record name and text. A channel message both among the
   * messages and in the mailbox shows once, among the messages. A term
   * under SEARCH_MIN finds nothing. Messages and files are newest first
   * across accounts; nothing comes from a server here, so `joinable`
   * stays empty.
   */
  async local(configIds: string[], term: string): Promise<SearchResults> {
    const out = emptyResults();
    if (!isSearchTerm(term)) return out;
    const channels = await this.conversations(configIds);
    for (const configId of configIds) {
      const [partners, membersOf, state] = await Promise.all([
        this.repo.partners(configId),
        this.repo.membersBySource(configId),
        this.repo.sourceState(configId),
      ]);
      const byPartner = new Map(partners.map((p) => [p.partnerId, p]));
      for (const c of channels.filter((x) => x.configId === configId)) {
        const name = displayNameOf(c, membersOf.get(c.channelId) ?? [], byPartner, state.selfPartnerId, getCurrentLocale());
        if (matchesTerm(foldText(name), term)) out.conversations.push({ configId, channelId: c.channelId });
      }
      for (const partner of await this.people.searchCached(configId, term, PEOPLE_MAX)) out.people.push({ configId, partner });
      const found = new Set<number>();
      for (const m of await this.repo.searchMessages(configId, term)) {
        if (m.messageId !== null) found.add(m.messageId);
        out.messages.push(hitOf(m, snippetOf(searchableText(m.body), term), null));
      }
      for (const a of await this.repo.sourceAttachments(configId)) {
        if (a.state === "draft" || a.state === "refused" || !matchesTerm(foldText(a.name), term)) continue;
        const m = a.messageId !== null
          ? await this.repo.message(configId, a.messageId)
          : a.postClientUuid ? await this.repo.messageByClientUuid(configId, a.postClientUuid) : null;
        if (!m || m.status === "failed") continue;
        out.files.push(hitOf(m, snippetOf(a.name, term), a.name));
      }
      for (const item of await this.repo.searchMailbox(configId, term)) {
        if (item.threadModel === "discuss.channel" && found.has(item.messageId)) continue;
        out.mailbox.push({ item, snippet: snippetOf(searchableText(item.body), term) });
      }
    }
    out.messages.sort(newestFirst);
    out.files.sort(newestFirst);
    return out;
  }

  /**
   * One page of the account's server matches for a term, newest first,
   * `before` bounding it to lower ids. With module 1.4 (serverSearch) the
   * module's route takes the term as typed and escapes it; a plain 404 of
   * it probes the module again (moduleRefused) and the search_read below
   * answers. Without the module: the member channel ids read fresh, then
   * mail.message of those channels whose body holds htmlTerm or whose
   * subject or a file name holds rawTerm, with the count of the same
   * domain (`before` bounds the page, never the count). Only member
   * channels are searched either way: never a public channel the user is
   * not in. Neither path marks anything read (no thread route, no
   * channel history route). A hit is a file hit (`fileName`) when its text
   * does not hold the term and one of its files' names does.
   *
   * Both paths match the stored HTML, so the client marker comment or a
   * link's address can hold the term where the shown text does not: a
   * message is kept only when its text (searchableText), one of its files'
   * names or its subject holds the term. `more` and `oldestId` come from the
   * page as answered, so the next page starts after the messages left out;
   * `dropped` says how many were, `count` being then only an upper bound.
   *
   * The hits stay in memory; only the authors' names are cached
   * (chat_partners). Odoo drops the rows the user may not read after its
   * limit, so a page short of SERVER_PAGE is not the end: `more` compares
   * with the count. The first page (no `before`) also asks the people
   * (searchPeople) and the public channels to join (joinableChannels);
   * a failure of those leaves them empty. Offline, or a request that
   * never left: nothing, `offline` true. Other errors propagate.
   */
  async server(src: ChatSource, term: string, before?: number): Promise<ServerResults> {
    const q = term.trim();
    const answer = (p: Partial<ServerResults>): ServerResults => ({
      hits: [], joinable: [], people: [], count: null, more: false, oldestId: null, scanned: 0, dropped: 0, offline: false, ...p,
    });
    if (!isSearchTerm(q)) return answer({});
    if (!(await this.isOnline())) return answer({ offline: true });
    try {
      const names = before === undefined ? this.names(src, q) : Promise.resolve({ people: [], joinable: [] });
      const page = ((await this.features(src.configId)).serverSearch ? await this.viaModule(src, q, before) : null)
        ?? (await this.viaDomain(src, q, before));
      const hits = page.messages.filter((m) => holdsTerm(m, q)).map((m) => serverHit(src.configId, m, q));
      const scanned = page.ids.length;
      return answer({
        ...(await names), hits, count: page.count, more: scanned > 0 && scanned < page.count,
        oldestId: scanned > 0 ? Math.min(...page.ids) : null, scanned, dropped: scanned - hits.length,
      });
    } catch (e) {
      if (e instanceof RequestNotSentError) return answer({ offline: true });
      throw e;
    }
  }

  /** The people and the channels to join whose name holds the term; a failure of either leaves it empty. */
  private async names(src: ChatSource, q: string): Promise<{ people: ChatPartner[]; joinable: JoinableChannel[] }> {
    const quiet = <T>(what: string, empty: T) => (e: unknown): T => {
      console.warn(`chat search: ${what} failed`, e);
      return empty;
    };
    const [people, joinable] = await Promise.all([
      this.people.searchPeople(src, q, SERVER_NAMES_MAX).catch(quiet<ChatPartner[]>("people", [])),
      this.people.joinableChannels(src, q, SERVER_NAMES_MAX).then((r) => r.channels).catch(quiet<JoinableChannel[]>("channels", [])),
    ]);
    return { people, joinable };
  }

  /** The module's page, or null when its route answers 404 (the module probed again). */
  private async viaModule(src: ChatSource, q: string, before?: number): Promise<ServerPage | null> {
    const { configId, creds } = src;
    let result: any;
    try {
      result = await this.rpc.callWithAuth(creds, async (sessionId) => {
        try {
          return await this.rpc.jsonRoute(creds.odooUrl, sessionId, MODULE_SEARCH_ROUTE, {
            search_term: q, before: before ?? null, limit: SERVER_PAGE,
          });
        } catch (e: unknown) {
          if (Object.getPrototypeOf(e) === Error.prototype && /^HTTP 404\b/.test((e as Error).message)) {
            throw new RouteMissingError((e as Error).message);
          }
          throw e;
        }
      });
    } catch (e) {
      if (!(e instanceof RouteMissingError)) throw e;
      try {
        await this.moduleRefused(configId);
      } catch (probe) {
        console.warn("chat search: module probe after a missing search route failed", probe);
      }
      return null;
    }
    const self = (await this.repo.sourceState(configId)).selfPartnerId;
    const delta = parseStore(result?.data, configId, self);
    await this.repo.applyDelta(configId, partnersOnly(delta.partners, self));
    const fileNames = new Map(delta.attachments.map((a) => [a.attachmentId, a.name ?? ""]));
    const byId = new Map(delta.messages.map((m) => [m.messageId, m]));
    const raw: any[] = Array.isArray(result?.data?.["mail.message"]) ? result.data["mail.message"] : [];
    const subjects = new Map(raw.filter((m) => typeof m?.id === "number").map((m) => [m.id as number, typeof m.subject === "string" ? m.subject : ""]));
    const ids: number[] = Array.isArray(result?.messages)
      ? result.messages.map((v: any) => (typeof v === "number" ? v : v?.id)).filter((v: any) => typeof v === "number")
      : [];
    const messages: ServerMessage[] = [];
    for (const id of ids) {
      const m = byId.get(id);
      if (!m || m.channelId === undefined) continue;
      messages.push({
        messageId: id, channelId: m.channelId, body: m.body ?? "", date: m.date ?? "", authorPartnerId: m.authorPartnerId ?? null,
        fileNames: (m.attachmentIds ?? []).map((a) => fileNames.get(a) ?? "").filter(Boolean),
        subject: subjects.get(id) ?? "",
      });
    }
    return { messages, ids, count: Number(result?.count) || 0 };
  }

  /** The search_read page over the member channels, with its count. */
  private async viaDomain(src: ChatSource, q: string, before?: number): Promise<ServerPage> {
    const { configId, creds } = src;
    const channels = await this.rpc.searchRead<{ id: number }>(creds, "discuss.channel", [["is_member", "=", true]], ["id"]);
    const ids = channels.map((c) => c.id);
    if (ids.length === 0) return { messages: [], ids: [], count: 0 };
    const domain: any[] = [
      ["model", "=", "discuss.channel"],
      ["res_id", "in", ids],
      ["message_type", "!=", "user_notification"],
      "|",
      "|",
      ["body", "ilike", htmlTerm(q)],
      ["subject", "ilike", rawTerm(q)],
      ["attachment_ids.name", "ilike", rawTerm(q)],
    ];
    const [rows, count] = await Promise.all([
      this.rpc.searchRead<any>(
        creds,
        "mail.message",
        before !== undefined ? [...domain, ["id", "<", before]] : domain,
        ["id", "body", "date", "author_id", "res_id", "attachment_ids", "subject"],
        { limit: SERVER_PAGE, order: "id desc" },
      ),
      this.rpc.callKw<number>(creds, "mail.message", "search_count", [domain]),
    ]);
    const self = (await this.repo.sourceState(configId)).selfPartnerId;
    const authors = rows
      .filter((r) => Array.isArray(r.author_id) && typeof r.author_id[0] === "number")
      .map((r) => ({ partnerId: r.author_id[0] as number, name: String(r.author_id[1] ?? "") }));
    if (authors.length > 0) await this.repo.applyDelta(configId, partnersOnly(authors, self));
    // The files' names only for the rows their text does not explain
    const unexplained = rows.filter((r) => !matchesTerm(foldText(searchableText(r.body || "")), q));
    const fileIds = [...new Set(unexplained.flatMap((r) => (Array.isArray(r.attachment_ids) ? r.attachment_ids : [])))];
    const names = new Map<number, string>();
    if (fileIds.length > 0) {
      for (const a of await this.rpc.searchRead<{ id: number; name: string }>(creds, "ir.attachment", [["id", "in", fileIds]], ["name"])) {
        names.set(a.id, a.name || "");
      }
    }
    const messages = rows.map((r) => ({
      messageId: r.id as number,
      channelId: r.res_id as number,
      body: r.body || "",
      date: r.date || "",
      authorPartnerId: Array.isArray(r.author_id) ? (r.author_id[0] as number) : null,
      fileNames: (Array.isArray(r.attachment_ids) ? r.attachment_ids : []).map((a: number) => names.get(a) ?? "").filter(Boolean),
      subject: typeof r.subject === "string" ? r.subject : "",
    }));
    return { messages, ids: messages.map((m) => m.messageId), count: Number(count) || 0 };
  }
}

/** Whether the shown parts of a server message hold the term: its text (searchableText), a file's name or its subject. */
function holdsTerm(m: ServerMessage, term: string): boolean {
  return matchesTerm(foldText(searchableText(m.body)), term)
    || m.fileNames.some((n) => matchesTerm(foldText(n), term))
    || matchesTerm(foldText(m.subject), term);
}

/**
 * The hit of a server message: a message hit quoting its text when the
 * text holds the term, else a file hit on the first file whose name holds
 * it, else a message hit quoting its subject when it holds the term (its
 * text when not).
 */
function serverHit(configId: string, m: ServerMessage, term: string): SearchHit {
  const text = searchableText(m.body);
  const inText = matchesTerm(foldText(text), term);
  const file = inText ? undefined : m.fileNames.find((n) => matchesTerm(foldText(n), term));
  const quoted = inText || file || !matchesTerm(foldText(m.subject), term) ? text : m.subject;
  return {
    configId,
    channelId: m.channelId,
    messageId: m.messageId,
    clientUuid: null,
    authorPartnerId: m.authorPartnerId,
    date: m.date,
    snippet: snippetOf(file ?? quoted, term),
    fileName: file ?? null,
    origin: "server",
  };
}

function hitOf(m: ChatMessage, snippet: string, fileName: string | null): SearchHit {
  return {
    configId: m.configId,
    channelId: m.channelId,
    messageId: m.messageId,
    clientUuid: m.messageId === null ? m.clientUuid : null,
    authorPartnerId: m.authorPartnerId,
    date: m.date,
    snippet,
    fileName,
    origin: "phone",
  };
}
