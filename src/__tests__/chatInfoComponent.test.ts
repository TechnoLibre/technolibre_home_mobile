// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventBus } from "@odoo/owl";

import { ChatInfoComponent, MUTE_CHOICES } from "../components/chat/chat_info_component";

function stubLocale() {
    const store: Record<string, string> = { app_lang: "en" };
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
    });
}

const channel = (p: any = {}) => ({
    configId: "a", channelId: 5, channelType: "group", name: "Team", description: "About",
    correspondentPartnerId: null, customChannelName: null, isEditable: true, isMember: true,
    needactionCounter: 0, groupBasedSubscription: false, parentChannelId: null, memberCount: 3,
    muteUntilDt: null, createOpId: null, createFailed: false, leftUnsent: false, ...p,
});
const member = (partnerId: number) => ({
    configId: "a", channelId: 5, memberId: partnerId, partnerId, seenMessageId: null,
    fetchedMessageId: null, isTyping: false, typingAt: null,
});
const people = [
    { partnerId: 1, name: "Me", imStatus: "online" },
    { partnerId: 7, name: "Alice Roy", imStatus: "online" },
    { partnerId: 8, name: "Bob", imStatus: "away" },
];
const carol = { partnerId: 9, name: "Carol", imStatus: null };

function fakeChat(ch: any = channel(), opts: { features?: any; global?: string | null; members?: any[] } = {}) {
    const state: any = { ch };
    return {
        state,
        sources: vi.fn().mockResolvedValue([{ configId: "a", label: "Srv", creds: {} }]),
        members: vi.fn(async () => opts.members ?? [member(1), member(7), member(8)]),
        features: vi.fn().mockResolvedValue({ canRemoveMembers: false, idempotentCreate: false, ...opts.features }),
        realIdOf: vi.fn(async () => null),
        discardCreate: vi.fn().mockResolvedValue(undefined),
        invite: vi.fn(async (s: any, id: number) => ({ configId: s.configId, channelId: id })),
        rename: vi.fn().mockResolvedValue(undefined),
        describe: vi.fn().mockResolvedValue(undefined),
        leave: vi.fn().mockResolvedValue(undefined),
        hide: vi.fn().mockResolvedValue(undefined),
        mute: vi.fn().mockResolvedValue(undefined),
        removeMember: vi.fn().mockResolvedValue(undefined),
        people: {
            inviteCandidates: vi.fn().mockResolvedValue({ partners: [carol, people[2]], count: 2, offline: false }),
            searchPeople: vi.fn().mockResolvedValue([carol, people[1]]),
            recentPeople: vi.fn().mockResolvedValue([carol, people[1]]),
        },
        repo: {
            channel: vi.fn(async () => state.ch),
            members: vi.fn(async () => opts.members ?? [member(1), member(7), member(8)]),
            partners: vi.fn().mockResolvedValue(people),
            sourceState: vi.fn().mockResolvedValue({ selfPartnerId: 1, globalMuteUntil: opts.global ?? null }),
        },
    };
}

function make(chat: any, ops: any[] = []) {
    stubLocale();
    const c = new (ChatInfoComponent as any)();
    c.env = {
        eventBus: new EventBus(),
        router: { getRouteParams: () => new Map([["source", "a"], ["channelId", "5"]]) },
        databaseService: { getOutboxOpsForConfig: vi.fn().mockResolvedValue(ops) },
    };
    Object.defineProperty(c, "chatService", { value: chat });
    c.navigate = vi.fn();
    c.setup();
    return c;
}

async function opened(chat: any, ops: any[] = []) {
    const c = make(chat, ops);
    await c.open();
    return c;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const future = (ms: number) => new Date(Date.now() + ms).toISOString().slice(0, 19).replace("T", " ");

describe("ChatInfoComponent", () => {
    it("rename and description follow the type and the right", async () => {
        const cases: [any, boolean, boolean, boolean][] = [
            // channel type, isEditable, canRename, canDescribe
            [channel({ channelType: "channel", isEditable: true }), true, true, true],
            [channel({ channelType: "channel", isEditable: false }), false, false, true],
            [channel({ channelType: "group", isEditable: null }), false, false, true],
            [channel({ channelType: "chat", isEditable: false, correspondentPartnerId: 7 }), true, false, false],
        ];
        for (const [ch, rename, edit, shown] of cases) {
            const c = await opened(fakeChat(ch));
            expect(c.state.canRename, ch.channelType + ch.isEditable).toBe(rename);
            expect(c.state.canEditDescription).toBe(edit);
            expect(c.state.showDescription).toBe(shown && (edit || !!ch.description));
        }
    });

    it("a description is hidden when empty and not editable, and never shown for a chat", async () => {
        const hidden = await opened(fakeChat(channel({ isEditable: false, description: "" })));
        expect(hidden.state.showDescription).toBe(false);
        const chat = await opened(fakeChat(channel({ channelType: "chat", description: "x", correspondentPartnerId: 7 })));
        expect(chat.state.showDescription).toBe(false);
    });

    it("a channel is never renamed to nothing; a group may be, a chat saves its own label", async () => {
        const chan = fakeChat(channel({ channelType: "channel" }));
        const c1 = await opened(chan);
        c1.onEditName();
        c1.onNameInput({ target: { value: "  " } });
        expect(c1.state.nameValid).toBe(false);
        await c1.onSaveName();
        expect(chan.rename).not.toHaveBeenCalled();
        c1.onNameInput({ target: { value: " News " } });
        await c1.onSaveName();
        expect(chan.rename).toHaveBeenCalledWith(expect.objectContaining({ configId: "a" }), 5, "News");

        const grp = fakeChat();
        const c2 = await opened(grp);
        c2.onEditName();
        c2.onNameInput({ target: { value: "" } });
        expect(c2.state.nameValid).toBe(true);
        await c2.onSaveName();
        expect(grp.rename).toHaveBeenCalledWith(expect.anything(), 5, "");

        const dm = fakeChat(channel({ channelType: "chat", correspondentPartnerId: 7, customChannelName: "Al", isEditable: false }));
        const c3 = await opened(dm);
        c3.onEditName();
        expect(c3.state.nameValue).toBe("Al");
        c3.onNameInput({ target: { value: "Ally" } });
        await c3.onSaveName();
        expect(dm.rename).toHaveBeenCalledWith(expect.anything(), 5, "Ally");
        expect(c3.state.editName).toBe(false);
    });

    it("saves the description when editable", async () => {
        const chat = fakeChat();
        const c = await opened(chat);
        c.onDescriptionInput({ target: { value: "New text" } });
        await c.onSaveDescription();
        expect(chat.describe).toHaveBeenCalledWith(expect.anything(), 5, "New text");
    });

    it("a failed action shows the notice and does not reject", async () => {
        const chat = fakeChat();
        chat.rename.mockRejectedValue(new Error("no"));
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const c = await opened(chat);
        c.onEditName();
        await expect(c.onSaveName()).resolves.toBeUndefined();
        expect(c.state.error).toBe("Could not do it. Try again.");
    });

    it("members carry a presence and the remove control needs the module, a system user and someone else", async () => {
        const plain = await opened(fakeChat());
        expect(plain.state.members.map((m: any) => [m.name, m.presence, m.canRemove])).toEqual([
            ["Me", "online", false], ["Alice Roy", "online", false], ["Bob", "away", false],
        ]);
        const admin = await opened(fakeChat(channel(), { features: { canRemoveMembers: true } }));
        expect(admin.state.members.map((m: any) => m.canRemove)).toEqual([false, true, true]);
        const dm = await opened(fakeChat(channel({ channelType: "chat", correspondentPartnerId: 7 }), { features: { canRemoveMembers: true } }));
        expect(dm.state.members.some((m: any) => m.canRemove)).toBe(false);
    });

    it("removing asks first, then removes that person", async () => {
        const chat = fakeChat(channel(), { features: { canRemoveMembers: true } });
        const c = await opened(chat);
        const bob = c.state.members[2];
        const ask = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
        await c.onRemove(bob);
        expect(chat.removeMember).not.toHaveBeenCalled();
        await c.onRemove(bob);
        expect(ask.mock.calls[0][0]).toContain("Bob");
        expect(chat.removeMember).toHaveBeenCalledWith(expect.anything(), 5, 8);
    });

    it("leave is offered as Odoo's canLeave and asks for confirmation", async () => {
        const offered = async (p: any) => (await opened(fakeChat(channel(p)))).state.canLeave;
        expect(await offered({ channelType: "group" })).toBe(true);
        expect(await offered({ channelType: "channel" })).toBe(true);
        expect(await offered({ channelType: "channel", needactionCounter: 2 })).toBe(false);
        expect(await offered({ channelType: "channel", groupBasedSubscription: true })).toBe(false);
        expect(await offered({ channelType: "channel", parentChannelId: 3 })).toBe(false);
        expect(await offered({ channelType: "chat", correspondentPartnerId: 7 })).toBe(false);

        const chat = fakeChat(channel({ channelType: "channel" }));
        const c = await opened(chat);
        const ask = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
        await c.onLeave();
        expect(chat.leave).not.toHaveBeenCalled();
        await c.onLeave();
        expect(ask).toHaveBeenCalledTimes(2);
        expect(chat.leave).toHaveBeenCalledTimes(1);
        expect(c.navigate).toHaveBeenCalledWith("/chat");
    });

    it("a group asks for confirmation too; a chat hides without asking", async () => {
        const g = fakeChat();
        const cg = await opened(g);
        const ask = vi.spyOn(window, "confirm").mockReturnValue(true);
        await cg.onLeave();
        expect(ask).toHaveBeenCalledTimes(1);
        expect(g.leave).toHaveBeenCalled();

        ask.mockClear();
        const d = fakeChat(channel({ channelType: "chat", correspondentPartnerId: 7 }));
        const cd = await opened(d);
        expect(cd.state.canHide).toBe(true);
        expect(cd.state.canLeave).toBe(false);
        await cd.onHide();
        expect(ask).not.toHaveBeenCalled();
        expect(d.hide).toHaveBeenCalledWith(expect.anything(), 5);
        expect(cd.navigate).toHaveBeenCalledWith("/chat");
    });

    it("a refused leave stays on the screen with a notice", async () => {
        const chat = fakeChat();
        chat.leave.mockRejectedValue(new Error("no"));
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(window, "confirm").mockReturnValue(true);
        const c = await opened(chat);
        await c.onLeave();
        expect(c.navigate).not.toHaveBeenCalled();
        expect(c.state.error).not.toBe("");
    });

    it("offers the mute durations, and unmute only when muted", async () => {
        expect(MUTE_CHOICES.map((m) => m.minutes)).toEqual([15, 60, 180, 480, 1440, -1]);
        const chat = fakeChat();
        const c = await opened(chat);
        expect(c.state.canMute).toBe(true);
        expect(c.state.muteLabel).toBe("Not muted");
        expect(c.state.muted).toBe(false);
        await c.onMute(60);
        expect(chat.mute).toHaveBeenCalledWith(expect.anything(), 5, 60);
        await c.onMute(-1);
        expect(chat.mute).toHaveBeenLastCalledWith(expect.anything(), 5, -1);
        await c.onUnmute();
        expect(chat.mute).toHaveBeenLastCalledWith(expect.anything(), 5, false);
    });

    it("shows the date of a mute, or that it lasts until turned back on", async () => {
        const dated = await opened(fakeChat(channel({ muteUntilDt: future(3600000) })));
        expect(dated.state.muted).toBe(true);
        expect(dated.state.muteLabel).toMatch(/^Muted until /);
        expect(dated.state.muteLabel).not.toContain("turned back on");
        const forever = await opened(fakeChat(channel({ muteUntilDt: "9999-12-31 23:59:59" })));
        expect(forever.state.muteLabel).toBe("Muted until turned back on");
        const past = await opened(fakeChat(channel({ muteUntilDt: "2001-01-01 00:00:00" })));
        expect(past.state.muted).toBe(false);
    });

    it("hides the mute section under the global mute and says until when", async () => {
        const chat = fakeChat(channel(), { global: future(3600000) });
        const c = await opened(chat);
        expect(c.state.canMute).toBe(false);
        expect(c.state.globalMuteLabel).toMatch(/^All notifications are muted until /);
        const forever = await opened(fakeChat(channel(), { global: "9999-12-31 23:59:59" }));
        expect(forever.state.canMute).toBe(false);
        expect(forever.state.globalMuteLabel).toContain("turned back on");
        const expired = await opened(fakeChat(channel(), { global: "2001-01-01 00:00:00" }));
        expect(expired.state.canMute).toBe(true);
        expect(expired.state.globalMuteLabel).toBe("");
    });

    it("invites into a group through the server's candidates and stays", async () => {
        const chat = fakeChat();
        const c = await opened(chat);
        expect(c.state.canInvite).toBe(true);
        await c.onInviteOpen();
        expect(chat.people.inviteCandidates).toHaveBeenCalledWith(expect.anything(), 5, "");
        expect(c.state.candidates.map((p: any) => p.name)).toEqual(["Carol"]);
        c.onPick(c.state.candidates[0]);
        await c.onInviteGo();
        expect(chat.invite).toHaveBeenCalledWith(expect.anything(), 5, [9]);
        expect(c.navigate).not.toHaveBeenCalled();
        expect(c.state.inviting).toBe(false);
    });

    it("a refused candidate search shows the notice", async () => {
        const chat = fakeChat(channel({ channelType: "channel" }));
        chat.people.inviteCandidates.mockRejectedValue(new Error("denied"));
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const c = await opened(chat);
        await c.onInviteOpen();
        expect(c.state.error).toBe("Could not do it. Try again.");
    });

    it("inviting into a chat searches people and opens the group created", async () => {
        const chat = fakeChat(channel({ channelType: "chat", correspondentPartnerId: 7 }));
        chat.invite.mockResolvedValue({ configId: "a|u", channelId: -4 });
        const c = await opened(chat);
        expect(c.state.canInvite).toBe(true);
        await c.onInviteOpen();
        expect(chat.people.recentPeople).toHaveBeenCalled();
        expect(chat.people.inviteCandidates).not.toHaveBeenCalled();
        c.onPick(c.state.candidates[0]);
        await c.onInviteGo();
        expect(chat.invite).toHaveBeenCalledWith(expect.anything(), 5, [9]);
        expect(c.navigate).toHaveBeenCalledWith("/chat/a%7Cu/-4");
    });

    it("a conversation being created shows its state and no management; an ambiguous one can be given up", async () => {
        const ch = channel({ channelId: 5, createOpId: "op1" });
        const pending = await opened(fakeChat(ch), [{ id: "op1", status: "pending", params: {} }]);
        expect(pending.state.create).toBe("pending");
        expect(pending.state.canLeave).toBe(false);
        expect(pending.state.canMute).toBe(false);
        expect(pending.state.canInvite).toBe(false);

        const chat = fakeChat(ch);
        const amb = await opened(chat, [{ id: "op1", status: "blocked", params: { blockedReason: "ambiguous" } }]);
        expect(amb.state.create).toBe("ambiguous");
        const ask = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
        await amb.onCancelCreate();
        expect(chat.discardCreate).not.toHaveBeenCalled();
        await amb.onCancelCreate();
        expect(ask).toHaveBeenCalledTimes(2);
        expect(chat.discardCreate).toHaveBeenCalledWith("a", 5);
        expect(amb.navigate).toHaveBeenCalledWith("/chat");
    });

    it("a refused create can be dismissed", async () => {
        const chat = fakeChat(channel({ createFailed: true }));
        const c = await opened(chat);
        expect(c.state.create).toBe("failed");
        vi.spyOn(window, "confirm").mockReturnValue(true);
        await c.onCancelCreate();
        expect(chat.discardCreate).toHaveBeenCalled();
    });

    it("a conversation that is gone says so", async () => {
        const chat = fakeChat(null);
        const c = await opened(chat);
        expect(c.state.found).toBe(false);
    });
});
