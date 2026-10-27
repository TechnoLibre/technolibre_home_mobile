import { describe, it, expect, beforeEach } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "../services/databaseService";
import { addChatTables } from "../services/migrations/addChatTables";
import { RequestNotSentError, type SyncCredentials } from "../services/odoo/odooRpcClient";
import { ChatRepository } from "../services/chat/chatRepository";
import { ChatPeople } from "../services/chat/chatPeople";
import {
  ChatMentions, adjustPicks, applySuggestion, mentionQuery, picksOf, picksToMentions, type MentionPick,
} from "../services/chat/chatMentions";
import type { ChatChannel } from "../models/chat";
import type { ChatSource } from "../services/chat/chatSources";
import type { StoreDelta } from "../services/chat/chatStore";

const CREDS: SyncCredentials = { odooUrl: "https://odoo.example.com", username: "alice", password: "pw", database: "db1" };
const CONFIG = "https://odoo.example.com|alice|db1";
const SRC = { configId: CONFIG, creds: CREDS } as unknown as ChatSource;
const SELF = 3;

const delta = (p: Partial<StoreDelta>): StoreDelta => ({
  channels: [], deletedChannelIds: [], members: [], deletedMemberIds: [], messages: [], partners: [], attachments: [], deletedAttachmentIds: [],
  inboxCounter: null, selfPartnerId: null, ...p,
});

/** A Store answer of get_mention_suggestions_from_channel: members of `channelId` for `members`, every partner of `partners`. */
const storeAnswer = (channelId: number, partners: { id: number; name: string }[], members: number[]) => ({
  "discuss.channel.member": members.map((id) => ({
    id: 900 + id, thread: { id: channelId, model: "discuss.channel" }, persona: { id, type: "partner" },
  })),
  "res.partner": partners,
});

describe("mentionQuery", () => {
  it("finds a delimiter at the start or after whitespace, nothing in a word", () => {
    expect(mentionQuery("@", 1)).toEqual({ kind: "@", term: "", start: 0 });
    expect(mentionQuery("hi @Al", 6)).toEqual({ kind: "@", term: "Al", start: 3 });
    expect(mentionQuery("hi\n#gen", 7)).toEqual({ kind: "#", term: "gen", start: 3 });
    expect(mentionQuery("write mail@x", 12)).toBeNull();
    expect(mentionQuery("@Al ice", 7)).toBeNull();
    expect(mentionQuery("hello", 5)).toBeNull();
  });

  it("reads up to the caret only", () => {
    expect(mentionQuery("@Alice and more", 3)).toEqual({ kind: "@", term: "Al", start: 0 });
    expect(mentionQuery("x @", 2)).toBeNull();
  });
});

describe("picks", () => {
  const alice: MentionPick = { kind: "partner", id: 7, text: "@Alice Roy", start: 3 };

  it("a pick replaces the query with its name and a space, the caret after it", () => {
    const q = mentionQuery("hi @Al there", 6)!;
    const r = applySuggestion("hi @Al there", q, 6, { kind: "partner", id: 7, name: "Alice Roy" });
    expect(r).toEqual({ text: "hi @Alice Roy  there", caret: 14, pick: alice });
    const sub = applySuggestion("#so", mentionQuery("#so", 3)!, 3, { kind: "channel", id: 4, name: "sous-fil", parentName: "général-test" });
    expect(sub.text).toBe("#général-test > sous-fil ");
    expect(sub.pick).toEqual({ kind: "channel", id: 4, text: "#général-test > sous-fil", start: 0, parentName: "général-test" });
    expect(applySuggestion("@ever", mentionQuery("@ever", 5)!, 5, { kind: "special", label: "everyone" }).text).toBe("@everyone ");
  });

  it("a pick survives an edit elsewhere, shifted, and goes when its text is edited", () => {
    const before = "hi @Alice Roy ok";
    expect(adjustPicks([alice], before, "oh hi @Alice Roy ok")).toEqual([{ ...alice, start: 6 }]);
    expect(adjustPicks([alice], before, "hi @Alice Roy ok!")).toEqual([alice]);
    expect(adjustPicks([alice], before, "hi @Alice Ry ok")).toEqual([]);
    expect(adjustPicks([alice], before, "hi @Alice Roxy ok")).toEqual([]);
    expect(adjustPicks([alice], before, "")).toEqual([]);
  });

  it("picksToMentions gives each person and channel once, without the special ones", () => {
    const picks: MentionPick[] = [
      alice, { ...alice, start: 20 },
      { kind: "channel", id: 4, text: "#général-test > sous-fil", start: 30, parentName: "général-test" },
      { kind: "channel", id: 3, text: "#général-test", start: 60 },
      { kind: "special", id: 0, text: "@everyone", start: 80 },
    ];
    expect(picksToMentions(picks)).toEqual({
      partners: [{ id: 7, name: "Alice Roy" }],
      channels: [{ id: 4, name: "sous-fil", parentName: "général-test" }, { id: 3, name: "général-test", parentName: null }],
    });
  });

  it("picksOf places the picks of a text where their text first is", () => {
    const m = { partners: [{ id: 7, name: "Alice Roy" }, { id: 8, name: "Bob" }], channels: [{ id: 3, name: "gen", parentName: null }] };
    expect(picksOf("hi @Alice Roy in #gen", m)).toEqual([
      { kind: "partner", id: 7, text: "@Alice Roy", start: 3 },
      { kind: "channel", id: 3, text: "#gen", start: 17, parentName: null },
    ]);
  });
});

describe("ChatMentions", () => {
  let repo: ChatRepository;
  let online: boolean;
  let kw: Array<{ model: string; method: string; args: any[]; kwargs: any }>;
  let answers: Record<string, any>;
  let mentions: ChatMentions;

  const ch = async (id: number) => (await repo.channel(CONFIG, id)) as ChatChannel;
  const names = (list: any[]) => list.map((s) => (s.kind === "special" ? "@" + s.label : s.name));

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    const db = new DatabaseService();
    await db.initialize();
    await addChatTables(db);
    repo = new ChatRepository(db);
    online = true;
    kw = [];
    answers = {};
    const rpc = {
      callKw: async (_c: any, model: string, method: string, args: any[], kwargs: any) => {
        kw.push({ model, method, args, kwargs });
        const a = answers[method];
        if (a instanceof Error) throw a;
        return a;
      },
    };
    const people = new ChatPeople(rpc as any, repo, async () => online);
    mentions = new ChatMentions(repo, rpc as any, people, async () => online);
    await repo.applyDelta(CONFIG, delta({
      selfPartnerId: SELF,
      partners: [
        { configId: CONFIG, partnerId: SELF, name: "Alice" },
        { configId: CONFIG, partnerId: 4, name: "Bob Lane" },
        { configId: CONFIG, partnerId: 5, name: "Élodie" },
        { configId: CONFIG, partnerId: 6, name: "Abel" },
        { configId: CONFIG, partnerId: 7, name: "" },
      ],
      channels: [
        { channelId: 20, channelType: "group", isMember: true, name: "" },
        { channelId: 21, channelType: "channel", isMember: true, name: "général-test", groupPublicId: null },
        { channelId: 22, channelType: "channel", isMember: true, name: "privé", groupPublicId: 1 },
        { channelId: 23, channelType: "channel", isMember: true, name: "sous-fil", parentChannelId: 21 },
        { channelId: 24, channelType: "channel", isMember: false, name: "général-autre" },
        { channelId: 25, channelType: "chat", isMember: true, name: "", correspondentPartnerId: 4 },
        { channelId: 26, channelType: "channel", isMember: true, name: "fil-orphelin", parentChannelId: 99 },
      ],
      members: [
        { memberId: 1, channelId: 20, partnerId: SELF }, { memberId: 2, channelId: 20, partnerId: 4 },
        { memberId: 3, channelId: 20, partnerId: 7 },
        { memberId: 4, channelId: 21, partnerId: SELF }, { memberId: 5, channelId: 21, partnerId: 5 },
        { memberId: 6, channelId: 22, partnerId: SELF }, { memberId: 7, channelId: 22, partnerId: 4 },
        { memberId: 8, channelId: 25, partnerId: SELF }, { memberId: 9, channelId: 25, partnerId: 4 },
      ],
    }));
  });

  it("offline a member list shows, the nameless left out", async () => {
    online = false;
    const q = mentionQuery("@", 1)!;
    expect(names(await mentions.local(SRC, await ch(20), q))).toEqual(["Alice", "Bob Lane"]);
    expect(names(await mentions.remote(SRC, await ch(20), q))).toEqual(["Alice", "Bob Lane"]);
    expect(kw).toEqual([]);
  });

  it("in a group a non-member from the server is not offered", async () => {
    answers.get_mention_suggestions_from_channel = storeAnswer(20, [{ id: 4, name: "Bob Lane" }, { id: 9, name: "Bob Stranger" }], [4]);
    const q = mentionQuery("@bob", 4)!;
    expect(names(await mentions.remote(SRC, await ch(20), q))).toEqual(["Bob Lane"]);
    expect(kw).toEqual([{
      model: "res.partner", method: "get_mention_suggestions_from_channel", args: [],
      kwargs: { channel_id: 20, search: "bob", limit: 8 },
    }]);
  });

  it("in a public channel he is, after the members, and the people cache shows offline", async () => {
    answers.get_mention_suggestions_from_channel = storeAnswer(21, [{ id: 9, name: "Elise Server" }, { id: 5, name: "Élodie" }], [5]);
    // Members first, then a name that starts with the term: « Abel » holds « el » further in
    expect(names(await mentions.remote(SRC, await ch(21), mentionQuery("@el", 3)!))).toEqual(["Élodie", "Elise Server", "Abel"]);
    online = false;
    // Abel is in the people cache, not a member: offered in a public channel only
    expect(names(await mentions.local(SRC, await ch(21), mentionQuery("@ab", 3)!))).toEqual(["Abel"]);
    expect(names(await mentions.local(SRC, await ch(22), mentionQuery("@ab", 3)!))).toEqual([]);
    expect(names(await mentions.local(SRC, await ch(20), mentionQuery("@ab", 3)!))).toEqual([]);
  });

  it("in a channel with an access group the server's partners are kept, the cache gives members only", async () => {
    answers.get_mention_suggestions_from_channel = storeAnswer(22, [{ id: 9, name: "Bob Grouped" }], []);
    expect(names(await mentions.remote(SRC, await ch(22), mentionQuery("@bo", 3)!))).toEqual(["Bob Lane", "Bob Grouped"]);
    // A sub-channel follows its parent's access: 21 is public
    online = false;
    expect(names(await mentions.local(SRC, await ch(23), mentionQuery("@ab", 3)!))).toEqual(["Abel"]);
    // A parent not cached leaves the access unknown: members only
    expect(names(await mentions.local(SRC, await ch(26), mentionQuery("@ab", 3)!))).toEqual([]);
  });

  it("@ever offers @everyone in a group or a channel, not in a chat, nor before 4 characters", async () => {
    online = false;
    const ever = mentionQuery("@ever", 5)!;
    expect(names(await mentions.local(SRC, await ch(21), ever))).toEqual(["@everyone"]);
    expect(names(await mentions.local(SRC, await ch(20), ever))).toEqual(["@everyone"]);
    expect(names(await mentions.local(SRC, await ch(25), ever))).toEqual([]);
    expect(names(await mentions.local(SRC, await ch(21), mentionQuery("@eve", 4)!))).toEqual([]);
    expect(names(await mentions.local(SRC, await ch(21), mentionQuery("@everyonex", 10)!))).toEqual([]);
  });

  it("# lists the member channels, a sub-channel under its parent's name, and the server's", async () => {
    online = false;
    const q = mentionQuery("#", 1)!;
    expect((await mentions.local(SRC, await ch(20), q)).map((s: any) => [s.id, s.name, s.parentName])).toEqual([
      [21, "général-test", null], [22, "privé", null], [23, "sous-fil", "général-test"],
    ]);
    online = true;
    answers.get_mention_suggestions = [
      { id: 30, model: "discuss.channel", name: "generic", channel_type: "channel", parent_channel_id: false },
      { id: 31, model: "discuss.channel", name: "gen-orphan", channel_type: "channel", parent_channel_id: { id: 99, model: "discuss.channel" } },
    ];
    expect(names(await mentions.remote(SRC, await ch(20), mentionQuery("#gen", 4)!))).toEqual(["général-test", "generic"]);
    expect(kw.at(-1)).toMatchObject({ model: "discuss.channel", method: "get_mention_suggestions", kwargs: { search: "gen", limit: 8 } });
  });

  it("the server's matches are kept as it matched them (by email too), the members-only rule still applied", async () => {
    // Matched by their email on the server: the name does not hold the term
    answers.get_mention_suggestions_from_channel = storeAnswer(21, [{ id: 9, name: "Zed Quill" }], []);
    expect(names(await mentions.remote(SRC, await ch(21), mentionQuery("@zq@", 4)!))).toEqual(["Zed Quill"]);
    answers.get_mention_suggestions_from_channel = storeAnswer(20, [{ id: 9, name: "Zed Quill" }, { id: 4, name: "Bob Lane" }], [4]);
    expect(names(await mentions.remote(SRC, await ch(20), mentionQuery("@lane.example", 13)!))).toEqual(["Bob Lane"]);
    // A channel the server matched is kept as it is, its name not compared again
    answers.get_mention_suggestions = [{ id: 30, model: "discuss.channel", name: "Équipe", channel_type: "channel", parent_channel_id: false }];
    expect(names(await mentions.remote(SRC, await ch(20), mentionQuery("#team", 5)!))).toEqual(["Équipe"]);
  });

  it("@everyone also answers its description, as the browser's list does", async () => {
    online = false;
    // The description in the app's language (« Notifier tout le monde » here)
    expect(names(await mentions.local(SRC, await ch(21), mentionQuery("@tout", 5)!))).toEqual(["@everyone"]);
    expect(names(await mentions.local(SRC, await ch(25), mentionQuery("@tout", 5)!))).toEqual([]);
    expect(names(await mentions.local(SRC, await ch(21), mentionQuery("@tou", 4)!))).toEqual([]);
  });

  it("a request that never left answers from the cache; another error propagates", async () => {
    answers.get_mention_suggestions_from_channel = new RequestNotSentError("offline");
    expect(names(await mentions.remote(SRC, await ch(20), mentionQuery("@b", 2)!))).toEqual(["Bob Lane"]);
    answers.get_mention_suggestions_from_channel = new Error("server");
    await expect(mentions.remote(SRC, await ch(20), mentionQuery("@b", 2)!)).rejects.toThrow("server");
  });

  describe("in a record's chatter (no conversation)", () => {
    it("@ offers the people cache at once, then the server's chatter suggestions with it", async () => {
      // The cache: a name that starts with the term first; self is not offered
      expect(names(await mentions.local(SRC, null, mentionQuery("@el", 3)!))).toEqual(["Élodie", "Abel"]);
      expect(names(await mentions.local(SRC, null, mentionQuery("@ali", 4)!))).toEqual([]);
      expect(kw).toEqual([]);
      answers.get_mention_suggestions = { "res.partner": [{ id: 9, name: "Elise Server" }, { id: 5, name: "Élodie" }] };
      expect(names(await mentions.forRecord(SRC, mentionQuery("@él", 3)!))).toEqual(["Elise Server", "Élodie", "Abel"]);
      expect(kw).toEqual([{ model: "res.partner", method: "get_mention_suggestions", args: [], kwargs: { search: "el", limit: 8 } }]);
      // Kept as the server matched them (by email), the special mention never offered
      answers.get_mention_suggestions = { "res.partner": [{ id: 9, name: "Zed Quill" }] };
      expect(names(await mentions.forRecord(SRC, mentionQuery("@zq@", 4)!))).toEqual(["Zed Quill"]);
      answers.get_mention_suggestions = { "res.partner": [] };
      expect(names(await mentions.forRecord(SRC, mentionQuery("@everyone", 9)!))).toEqual([]);
      expect(names(await mentions.local(SRC, null, mentionQuery("@tout", 5)!))).toEqual([]);
    });

    it("offline, or a request that never left, answers from the people cache", async () => {
      online = false;
      expect(names(await mentions.forRecord(SRC, mentionQuery("@b", 2)!))).toEqual(["Bob Lane", "Abel"]);
      expect(kw).toEqual([]);
      online = true;
      answers.get_mention_suggestions = new RequestNotSentError("offline");
      expect(names(await mentions.forRecord(SRC, mentionQuery("@b", 2)!))).toEqual(["Bob Lane", "Abel"]);
    });

    it("# lists the channels as in a conversation", async () => {
      online = false;
      expect(names(await mentions.local(SRC, null, mentionQuery("#", 1)!))).toEqual(["général-test", "privé", "sous-fil"]);
      online = true;
      answers.get_mention_suggestions = [{ id: 30, model: "discuss.channel", name: "generic", channel_type: "channel", parent_channel_id: false }];
      expect(names(await mentions.forRecord(SRC, mentionQuery("#gen", 4)!))).toEqual(["général-test", "generic"]);
      expect(kw.at(-1)).toMatchObject({ model: "discuss.channel", method: "get_mention_suggestions", kwargs: { search: "gen", limit: 8 } });
    });
  });
});
