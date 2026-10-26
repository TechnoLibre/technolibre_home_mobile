import { getCurrentLocale } from "../../i18n";
import type { ChatChannel, ChatMailboxItem, ChatMessage, ChatPartner } from "../../models/chat";
import type { OdooRpcClient } from "../odoo/odooRpcClient";
import { foldText, searchableText } from "./chatBody";
import { displayNameOf } from "./chatNames";
import type { ChatPeople, JoinableChannel } from "./chatPeople";
import type { ChatRepository } from "./chatRepository";

/** The fewest characters, folded and trimmed, a term needs before it is searched. */
export const SEARCH_MIN = 2;

/** The most people the cache gives for one account. */
const PEOPLE_MAX = 10;

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
 * Search over the chat of the phone and of the servers. local() reads the
 * cache only, so it answers offline and never marks anything read.
 */
export class ChatSearch {
  /** The conversations of the accounts as the list shows them; ChatService gives its own. */
  conversations: (configIds: string[]) => Promise<ChatChannel[]> = async () => [];

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
        if (m.status === "failed") continue;
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
