import { describe, it, expect, beforeEach } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "../services/databaseService";
import { addChatTables } from "../services/migrations/addChatTables";
import { ChatRepository } from "../services/chat/chatRepository";
import { ChatPeople } from "../services/chat/chatPeople";
import {
  ChatSearch,
  SEARCH_MIN,
  htmlTerm,
  isSearchTerm,
  likeEscape,
  likePattern,
  markParts,
  matchesTerm,
  mergeHits,
  rawTerm,
  snippetOf,
  type SearchHit,
} from "../services/chat/chatSearch";
import { chatMarker } from "../services/chat/chatBody";
import type { StoreDelta } from "../services/chat/chatStore";
import type { ChatMessage } from "../models/chat";

const A = "https://odoo.example.com|alice|db1";
const B = "https://odoo.example.com|bob|db1";

const delta = (p: Partial<StoreDelta>): StoreDelta => ({
  channels: [], deletedChannelIds: [], members: [], deletedMemberIds: [], messages: [], partners: [], attachments: [], deletedAttachmentIds: [],
  inboxCounter: null, selfPartnerId: null, ...p,
});

const sent = (messageId: number, body: string, over: Partial<ChatMessage> = {}) => ({
  messageId, channelId: 7, body, authorPartnerId: 4, date: `2026-10-26 10:00:${String(messageId % 60).padStart(2, "0")}`,
  messageType: "comment", status: "sent" as const, ...over,
});

describe("search terms", () => {
  it("a term counts once folded and trimmed", () => {
    expect(SEARCH_MIN).toBe(2);
    expect(isSearchTerm(" é ")).toBe(false);
    expect(isSearchTerm(" éa ")).toBe(true);
    expect(isSearchTerm("   ")).toBe(false);
  });

  it("likeEscape puts a backslash before the backslash and the wildcards", () => {
    expect(likeEscape("100%_a\\b")).toBe("100\\%\\_a\\\\b");
  });

  it("likePattern folds the term and joins its words by %", () => {
    expect(likePattern("Café  Crème")).toBe("%cafe%creme%");
    expect(likePattern("100%")).toBe("%100\\%%");
  });

  it("two words match in order", () => {
    expect(matchesTerm("cafe au lait et creme", "café crème")).toBe(true);
    expect(matchesTerm("creme puis cafe", "café crème")).toBe(false);
    expect(matchesTerm("", "ca")).toBe(false);
  });

  it("a term with % matches only a literal percent", () => {
    expect(matchesTerm("100% sur", "100%")).toBe(true);
    expect(matchesTerm("1000 sur", "100%")).toBe(false);
    expect(matchesTerm("a_b", "a_b")).toBe(true);
    expect(matchesTerm("axb", "a_b")).toBe(false);
  });

  it("snippetOf cuts around the first match, with an ellipsis at each cut end", () => {
    const long = "début " + "x".repeat(100) + " le Café ici " + "y".repeat(100);
    const s = snippetOf(long, "cafe", 40);
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
    expect(s).toContain("Café");
    expect(Array.from(s).length).toBeLessThanOrEqual(40);
    expect(snippetOf("court  texte\nici", "texte")).toBe("court texte ici");
    expect(snippetOf("a".repeat(100), "zz", 10)).toBe("a".repeat(9) + "…");
  });

  it("the server terms escape as the module does: entities in the body only, wildcards everywhere, spaces as %", () => {
    expect(htmlTerm("l'eau & co")).toBe("l'eau%&amp;%co");
    expect(rawTerm("l'eau & co")).toBe("l'eau%&%co");
    expect(htmlTerm('<b> "100%"_\\')).toBe('&lt;b&gt;%"100\\%"\\_\\\\');
    expect(rawTerm("café crème")).toBe("café%crème");
  });

  it("markParts marks each word of the term, accents and case ignored", () => {
    expect(markParts("Un Café et une crème", "cafe creme")).toEqual([
      { text: "Un ", mark: false }, { text: "Café", mark: true }, { text: " et une ", mark: false }, { text: "crème", mark: true },
    ]);
    expect(markParts("rien", "zz")).toEqual([{ text: "rien", mark: false }]);
  });
});

describe("mergeHits", () => {
  const hit = (configId: string, messageId: number | null, date: string, origin: "phone" | "server", p: Partial<SearchHit> = {}): SearchHit => ({
    configId, channelId: 7, messageId, clientUuid: messageId === null ? "q1" : null, authorPartnerId: 4, date,
    snippet: origin, fileName: null, origin, ...p,
  });

  it("a server hit already on the phone shows once", () => {
    const merged = mergeHits(
      [hit(A, 60, "2026-10-26 08:00:00", "phone"), hit(A, null, "2026-10-26 12:00:00", "phone")],
      [hit(A, 61, "2026-10-26 10:00:00", "server"), hit(A, 60, "2026-10-26 08:00:00", "server"), hit(B, 60, "2026-10-26 09:00:00", "server")],
    );
    expect(merged.map((h) => [h.configId, h.messageId, h.origin])).toEqual([
      [A, null, "phone"], [A, 61, "server"], [B, 60, "server"], [A, 60, "phone"],
    ]);
  });
});

describe("ChatSearch.local", () => {
  let db: DatabaseService;
  let repo: ChatRepository;
  let search: ChatSearch;
  let online: boolean;
  let calls: string[];

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await addChatTables(db);
    repo = new ChatRepository(db);
    online = false;
    calls = [];
    const rpc = new Proxy({}, { get: (_t, name) => async () => { calls.push(String(name)); throw new Error("no server"); } });
    const people = new ChatPeople(rpc as any, repo, async () => online);
    search = new ChatSearch(repo, people, rpc as any, async () => ({ serverSearch: false }), async () => online);
    search.conversations = async (ids) => (await Promise.all(ids.map((id) => repo.channels(id)))).flat();
    await repo.applyDelta(A, delta({
      selfPartnerId: 3,
      channels: [
        { channelId: 7, channelType: "channel", name: "général-test", isMember: true },
        { channelId: 8, channelType: "chat", name: "", isMember: true, isPinned: true, correspondentPartnerId: 4 },
      ],
      partners: [
        { configId: A, partnerId: 3, name: "Moi Test" },
        { configId: A, partnerId: 4, name: "Élodie Martin" },
      ],
    }));
  });

  it("folded term finds accented text", async () => {
    await repo.applyDelta(A, delta({ messages: [sent(60, "<p>Un Café <b>crème</b></p>"), sent(61, "<p>thé</p>")] }));
    const r = await search.local([A], "CAFE creme");
    expect(r.messages.map((h) => h.messageId)).toEqual([60]);
    expect(r.messages[0]).toMatchObject({
      configId: A, channelId: 7, clientUuid: null, authorPartnerId: 4, snippet: "Un Café crème", fileName: null, origin: "phone",
    });
  });

  it("a term with % matches only a literal percent", async () => {
    await repo.applyDelta(A, delta({ messages: [sent(60, "<p>100% fait</p>"), sent(61, "<p>1000 faits</p>")] }));
    expect((await search.local([A], "100%")).messages.map((h) => h.messageId)).toEqual([60]);
  });

  it("two words match in order", async () => {
    await repo.applyDelta(A, delta({ messages: [sent(60, "<p>café puis crème</p>"), sent(61, "<p>crème puis café</p>")] }));
    expect((await search.local([A], "cafe creme")).messages.map((h) => h.messageId)).toEqual([60]);
  });

  it("the marker comment is never matched", async () => {
    const uuid = "0f1e2d3c-aaaa-bbbb-cccc-000000000001";
    await repo.applyDelta(A, delta({
      messages: [sent(60, `<p>bonjour</p>${chatMarker(uuid)}<p><small>erplibre-mobile:${uuid}</small></p>`)],
      mailbox: [{ messageId: 90, threadModel: "project.task", threadId: 5, recordName: "Tâche démo", body: `<p>vu</p><p><small>erplibre-mobile:${uuid}</small></p>`, needaction: true }],
    }));
    for (const term of ["erplibre", "mobile:", "0f1e2d"]) {
      const r = await search.local([A], term);
      expect(r.messages).toEqual([]);
      expect(r.mailbox).toEqual([]);
    }
    expect((await search.local([A], "bonjour")).messages[0].snippet).toBe("bonjour");
  });

  it("a failed post is not a hit", async () => {
    await repo.putPending({
      configId: A, channelId: 7, messageId: null, clientUuid: "u1", authorPartnerId: 3, body: "<p>cafe pas parti</p>",
      date: "2026-10-26 11:00:00", messageType: "comment", status: "pending", outboxOpId: "op1", writeDate: null,
    });
    await repo.putPending({
      configId: A, channelId: 7, messageId: null, clientUuid: "u2", authorPartnerId: 3, body: "<p>cafe en route</p>",
      date: "2026-10-26 11:00:01", messageType: "comment", status: "pending", outboxOpId: "op2", writeDate: null,
    });
    await repo.markFailed(A, "u1", "refused");
    const r = await search.local([A], "cafe");
    expect(r.messages.map((h) => [h.messageId, h.clientUuid])).toEqual([[null, "u2"]]);
  });

  it("a file is found by its name", async () => {
    await repo.applyDelta(A, delta({
      messages: [sent(60, "<p>voici</p>", { attachmentIds: [90] } as any), sent(61, "", { attachmentIds: [91] } as any)],
      attachments: [
        { attachmentId: 90, channelId: 7, name: "Devis Été.pdf", mimetype: "application/pdf" },
        { attachmentId: 91, channelId: 7, name: "photo.jpg", mimetype: "image/jpeg" },
      ],
    }));
    const r = await search.local([A], "devis ete");
    expect(r.files).toEqual([{
      configId: A, channelId: 7, messageId: 60, clientUuid: null, authorPartnerId: 4, date: "2026-10-26 10:00:00",
      snippet: "Devis Été.pdf", fileName: "Devis Été.pdf", origin: "phone",
    }]);
    expect(r.messages).toEqual([]);
  });

  it("a conversation is found by its display name", async () => {
    expect((await search.local([A], "elodie")).conversations).toEqual([{ configId: A, channelId: 8 }]);
    expect((await search.local([A], "general")).conversations).toEqual([{ configId: A, channelId: 7 }]);
  });

  it("people come from the cache offline", async () => {
    const r = await search.local([A], "mart");
    expect(r.people.map((p) => [p.configId, p.partner.name])).toEqual([[A, "Élodie Martin"]]);
    expect(r.joinable).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("an inbox item of a task is found by its record name and its text", async () => {
    await repo.applyDelta(A, delta({
      mailbox: [
        { messageId: 90, threadModel: "project.task", threadId: 5, recordName: "Tâche démo", body: "<p>Rien à voir</p>", needaction: true, date: "2026-10-26 09:00:00" },
        { messageId: 91, threadModel: "project.task", threadId: 6, recordName: "Autre fiche", body: "<p>Le devis démo est prêt</p>", starred: true, date: "2026-10-26 09:01:00" },
        { messageId: 92, threadModel: "project.task", threadId: 6, recordName: "Autre fiche", body: "<p>sans rapport</p>", history: true },
      ],
    }));
    const r = await search.local([A], "demo");
    expect(r.mailbox.map((m) => [m.item.messageId, m.snippet])).toEqual([[91, "Le devis démo est prêt"], [90, "Rien à voir"]]);
    expect((await search.local([A], "tache")).mailbox.map((m) => m.item.messageId)).toEqual([90]);
  });

  it("a channel mention in the mailbox shows once, among the messages", async () => {
    await repo.applyDelta(A, delta({
      messages: [sent(60, "<p>@Moi Test regarde le devis</p>")],
      mailbox: [
        { messageId: 60, threadModel: "discuss.channel", threadId: 7, recordName: "général-test", body: "<p>@Moi Test regarde le devis</p>", needaction: true },
        { messageId: 70, threadModel: "discuss.channel", threadId: 9, recordName: "Autre canal", body: "<p>un devis ailleurs</p>", needaction: true },
      ],
    }));
    const r = await search.local([A], "devis");
    expect(r.messages.map((h) => h.messageId)).toEqual([60]);
    expect(r.mailbox.map((m) => m.item.messageId)).toEqual([70]);
  });

  it("each account is searched, the messages newest first", async () => {
    await repo.applyDelta(A, delta({ messages: [sent(60, "<p>devis A</p>", { date: "2026-10-26 08:00:00" })] }));
    await repo.applyDelta(B, delta({ messages: [sent(61, "<p>devis B</p>", { date: "2026-10-26 09:00:00" })] }));
    const r = await search.local([A, B], "devis");
    expect(r.messages.map((h) => [h.configId, h.messageId])).toEqual([[B, 61], [A, 60]]);
    expect((await search.local([A], "devis")).messages.map((h) => h.configId)).toEqual([A]);
  });

  it("a term under SEARCH_MIN finds nothing", async () => {
    await repo.applyDelta(A, delta({ messages: [sent(60, "<p>a</p>")] }));
    const r = await search.local([A], " a ");
    expect([r.messages, r.conversations, r.people, r.files, r.mailbox]).toEqual([[], [], [], [], []]);
  });
});
