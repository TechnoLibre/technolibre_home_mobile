import { describe, it, expect, beforeEach } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "../services/databaseService";
import { addChatTables } from "../services/migrations/addChatTables";
import { RequestNotSentError, type SyncCredentials } from "../services/odoo/odooRpcClient";
import { ChatRepository } from "../services/chat/chatRepository";
import { ChatPeople } from "../services/chat/chatPeople";
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

describe("ChatPeople", () => {
  let repo: ChatRepository;
  let online: boolean;
  let kw: Array<{ model: string; method: string; args: any[] }>;
  let reads: Array<{ model: string; domain: any[]; fields: string[]; options: any }>;
  let answers: Record<string, any>;
  let people: ChatPeople;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    const db = new DatabaseService();
    await db.initialize();
    await addChatTables(db);
    repo = new ChatRepository(db);
    online = true;
    kw = [];
    reads = [];
    answers = {};
    const rpc = {
      callKw: async (_c: any, model: string, method: string, args: any[]) => {
        kw.push({ model, method, args });
        const a = answers[method];
        if (a instanceof Error) throw a;
        return a;
      },
      searchRead: async (_c: any, model: string, domain: any[], fields: string[], options: any) => {
        reads.push({ model, domain, fields, options });
        const a = answers[model];
        if (a instanceof Error) throw a;
        return a ?? [];
      },
      sessionInfo: async () => ({ uid: 2 }),
    };
    people = new ChatPeople(rpc as any, repo, async () => online);
    await repo.applyDelta(CONFIG, delta({
      selfPartnerId: SELF,
      partners: [
        { configId: CONFIG, partnerId: SELF, name: "Alice" },
        { configId: CONFIG, partnerId: 4, name: "Bob" },
        { configId: CONFIG, partnerId: 5, name: "Élodie" },
        { configId: CONFIG, partnerId: 6, name: "Carl" },
        { configId: CONFIG, partnerId: 7, name: "Dan" },
      ],
      channels: [
        { channelId: 10, channelType: "chat", isMember: true, isPinned: true, correspondentPartnerId: 4, lastInterestDt: "2026-10-25 09:00:00" },
        { channelId: 11, channelType: "chat", isMember: true, isPinned: true, correspondentPartnerId: 5, lastInterestDt: "2026-10-25 09:00:00" },
        { channelId: 12, channelType: "chat", isMember: true, isPinned: false, correspondentPartnerId: 6, lastInterestDt: "2026-10-25 12:00:00" },
        { channelId: 13, channelType: "chat", isMember: true, isPinned: true, correspondentPartnerId: SELF, lastInterestDt: "2026-10-25 13:00:00" },
        { channelId: 14, channelType: "chat", isMember: true, isPinned: true, correspondentPartnerId: 4, lastInterestDt: "2026-10-25 01:00:00" },
        { channelId: 15, channelType: "group", isMember: true, isPinned: true, correspondentPartnerId: null, lastInterestDt: "2026-10-25 14:00:00" },
      ],
    }));
  });

  it("recent people: interest desc, id desc, no hidden chat, no self, no duplicate", async () => {
    expect((await people.recentPeople(CONFIG)).map((p) => p.partnerId)).toEqual([5, 4]);
  });

  it("search merges the partners found and asks im_search with no exclusion", async () => {
    answers.im_search = { "res.partner": [{ id: 9, name: "Zoe", im_status: "online" }, { id: 8, name: "Abel" }] };
    const found = await people.searchPeople(SRC, "o", 5);
    expect(kw[0]).toMatchObject({ model: "res.partner", method: "im_search", args: ["o", 5, []] });
    expect(found.map((p) => p.name)).toEqual(["Abel", "Zoe"]);
    expect((await repo.partners(CONFIG)).find((p) => p.partnerId === 9)).toMatchObject({ name: "Zoe", imStatus: "online" });
  });

  it("search with no hit answers an empty list", async () => {
    answers.im_search = {};
    expect(await people.searchPeople(SRC, "zzz")).toEqual([]);
  });

  it("offline search reads the cache: accents and case ignored, recent first, self out", async () => {
    online = false;
    expect(await people.searchPeople(SRC, "")).toHaveLength(4);
    expect((await people.searchPeople(SRC, "")).map((p) => p.partnerId)).toEqual([5, 4, 6, 7]);
    expect((await people.searchPeople(SRC, "ELO")).map((p) => p.name)).toEqual(["Élodie"]);
    expect((await people.searchPeople(SRC, "", 2)).length).toBe(2);
    expect(await people.searchPeople(SRC, "alice")).toEqual([]);
    expect(kw).toEqual([]);
  });

  it("a request not sent falls back to the cache; another error propagates", async () => {
    answers.im_search = new RequestNotSentError("down");
    expect((await people.searchPeople(SRC, "car")).map((p) => p.partnerId)).toEqual([6]);
    answers.im_search = new Error("boom");
    await expect(people.searchPeople(SRC, "car")).rejects.toThrow("boom");
  });

  it("joinable channels use the exact domain and map the rows", async () => {
    answers["discuss.channel"] = [
      { id: 20, name: "Open", description: false, member_count: 3, group_public_id: false },
      { id: 21, name: "Staff", description: "Staff only", member_count: 9, group_public_id: [11, "Role / Staff"] },
    ];
    const r = await people.joinableChannels(SRC, "o");
    expect(reads[0]).toMatchObject({
      model: "discuss.channel",
      domain: [["parent_channel_id", "=", false], ["channel_type", "=", "channel"], ["is_member", "=", false], ["name", "ilike", "o"]],
      fields: ["name", "description", "member_count", "group_public_id"],
      options: { limit: 50 },
    });
    expect(r).toEqual({
      offline: false,
      channels: [
        { channelId: 20, name: "Open", description: "", memberCount: 3, groupName: "" },
        { channelId: 21, name: "Staff", description: "Staff only", memberCount: 9, groupName: "Role / Staff" },
      ],
    });
    expect((await repo.channels(CONFIG)).some((c) => c.channelId === 20)).toBe(false);
  });

  it("joinable channels offline", async () => {
    online = false;
    expect(await people.joinableChannels(SRC)).toEqual({ channels: [], offline: true });
    online = true;
    answers["discuss.channel"] = new RequestNotSentError("down");
    expect(await people.joinableChannels(SRC)).toEqual({ channels: [], offline: true });
  });

  it("invite candidates ask the channel and merge the partners", async () => {
    answers.search_for_channel_invite = { count: 31, data: { "res.partner": [{ id: 9, name: "Zoe" }] } };
    const r = await people.inviteCandidates(SRC, 20, "z");
    expect(kw[0]).toMatchObject({ method: "search_for_channel_invite", args: ["z", 20] });
    expect(r).toMatchObject({ count: 31, offline: false });
    expect(r.partners.map((p) => p.name)).toEqual(["Zoe"]);
    expect((await repo.partners(CONFIG)).some((p) => p.partnerId === 9)).toBe(true);
    online = false;
    expect(await people.inviteCandidates(SRC, 20, "z")).toEqual({ partners: [], count: 0, offline: true });
  });

  it("access groups: the user's own, sorted, everyone last, default internal users", async () => {
    await repo.setSourceState({ configId: CONFIG, internalUserGroupId: 11 });
    answers["res.groups"] = [{ id: 30, full_name: "Sales / Manager" }, { id: 11, full_name: "User types / Internal User" }];
    const r = await people.accessGroups(SRC);
    expect(reads[0]).toMatchObject({
      model: "res.groups", domain: [["share", "=", false], ["users", "in", [2]]], fields: ["full_name"],
    });
    expect(r.defaultId).toBe(11);
    expect(r.groups.map((g) => g.id)).toEqual([30, 11, false]);
    expect(r.groups[r.groups.length - 1]).toMatchObject({ id: false });
    expect(r.groups[r.groups.length - 1].fullName).not.toBe("");
  });

  it("access groups offer the default first when the user's groups lack it, and work offline", async () => {
    await repo.setSourceState({ configId: CONFIG, internalUserGroupId: 11 });
    answers["res.groups"] = [{ id: 30, full_name: "Sales / Manager" }];
    expect((await people.accessGroups(SRC)).groups.map((g) => g.id)).toEqual([11, 30, false]);
    online = false;
    const off = await people.accessGroups(SRC);
    expect(off).toMatchObject({ defaultId: 11, offline: true });
    expect(off.groups.map((g) => g.id)).toEqual([11, false]);
  });

  it("access groups with no known default", async () => {
    answers["res.groups"] = [{ id: 30, full_name: "Sales / Manager" }];
    const r = await people.accessGroups(SRC);
    expect(r.defaultId).toBe(false);
    expect(r.groups.map((g) => g.id)).toEqual([30, false]);
  });
});
