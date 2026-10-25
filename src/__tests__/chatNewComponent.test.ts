// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";

import { ChatNewComponent, SEARCH_DEBOUNCE_MS } from "../components/chat/chat_new_component";
import { ChatListComponent } from "../components/chat/chat_list_component";

function stubStorage(init: Record<string, string> = {}) {
    const store: Record<string, string> = { app_lang: "en", ...init };
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
    });
    return store;
}

const src = (id: string) => ({ configId: id, label: id, app: {}, creds: {} });
const person = (id: number, name: string) => ({ configId: "a", partnerId: id, name, imStatus: null });

function fakeChat(ids: string[]) {
    return {
        sources: vi.fn().mockResolvedValue(ids.map(src)),
        startDirect: vi.fn(async (s: any, id: number) => ({ configId: s.configId, channelId: -id })),
        createGroup: vi.fn(async (s: any) => ({ configId: s.configId, channelId: -50 })),
        createChannel: vi.fn(async (s: any) => ({ configId: s.configId, channelId: 60 })),
        join: vi.fn(async (s: any, id: number) => ({ configId: s.configId, channelId: id })),
        people: {
            recentPeople: vi.fn().mockResolvedValue([person(1, "Alice"), person(2, "Bob")]),
            searchPeople: vi.fn().mockResolvedValue([person(3, "Carol"), person(1, "Alice")]),
            joinableChannels: vi.fn().mockResolvedValue({
                channels: [{ channelId: 9, name: "general", description: "", memberCount: 3, groupName: "" }],
                offline: false,
            }),
            accessGroups: vi.fn().mockResolvedValue({
                groups: [{ id: 11, fullName: "Internal users" }, { id: 12, fullName: "Sales" }, { id: false, fullName: "Everyone" }],
                defaultId: 11,
                offline: false,
            }),
        },
    };
}

async function make(chat: any, storage: Record<string, string> = {}) {
    stubStorage(storage);
    const c = new (ChatNewComponent as any)();
    Object.defineProperty(c, "chatService", { value: chat });
    c.navigate = vi.fn();
    c.setup();
    await c.init();
    return c;
}

const input = (value: string) => ({ target: { value } }) as any;

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("ChatNewComponent", () => {
    it("modes follow the number of servers", async () => {
        const modes: string[] = [];
        for (const n of [1, 3, 6]) {
            const c = await make(fakeChat(Array.from({ length: n }, (_, i) => "s" + i)));
            modes.push(c.state.mode);
        }
        expect(modes).toEqual(["none", "chips", "dropdown"]);
    });

    it("preselects the list filter, else the last server used here, else the first", async () => {
        const ids = ["a", "b", "c"];
        expect((await make(fakeChat(ids), { "chat.filter": "b", "chat.new.server": "c" })).state.serverId).toBe("b");
        expect((await make(fakeChat(ids), { "chat.new.server": "c" })).state.serverId).toBe("c");
        expect((await make(fakeChat(ids), { "chat.filter": "gone" })).state.serverId).toBe("a");
        const c = await make(fakeChat(ids));
        await c.onServer("b");
        expect(c.state.serverId).toBe("b");
        expect(localStorage.getItem("chat.new.server")).toBe("b");
    });

    it("shows recent people, then the search after the debounce; empty term is recent only", async () => {
        vi.useFakeTimers();
        const chat = fakeChat(["a"]);
        const c = await make(chat);
        expect(c.shownPeople().map((p: any) => p.name)).toEqual(["Alice", "Bob"]);
        c.onQueryInput(input("car"));
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
        expect(chat.people.searchPeople).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(chat.people.searchPeople).toHaveBeenCalledTimes(1);
        expect(chat.people.searchPeople.mock.calls[0][1]).toBe("car");
        expect(c.shownPeople().map((p: any) => p.name)).toEqual(["Carol", "Alice"]);
        c.onQueryInput(input("  "));
        expect(c.shownPeople().map((p: any) => p.name)).toEqual(["Alice", "Bob"]);
    });

    it("a search error shows a notice instead of rejecting", async () => {
        const chat = fakeChat(["a"]);
        chat.people.searchPeople.mockRejectedValue(new Error("boom"));
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const c = await make(chat);
        await expect(c.search("x")).resolves.toBeUndefined();
        expect(c.state.error).toBe("Could not do it. Try again.");
    });

    it("tapping a person opens the thread of the direct message, temp id included", async () => {
        const chat = fakeChat(["a|u|d"]);
        const c = await make(chat);
        await c.onPerson(c.state.recent[0]);
        expect(chat.startDirect).toHaveBeenCalledWith(expect.objectContaining({ configId: "a|u|d" }), 1);
        expect(c.navigate).toHaveBeenCalledWith("/chat/a%7Cu%7Cd/-1");
    });

    it("a failing action shows a notice and does not navigate", async () => {
        const chat = fakeChat(["a"]);
        chat.startDirect.mockRejectedValue(new Error("no"));
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const c = await make(chat);
        await c.onPerson(c.state.recent[0]);
        expect(c.navigate).not.toHaveBeenCalled();
        expect(c.state.error).not.toBe("");
        expect(c.state.busy).toBe(false);
    });

    it("a group needs two people; one person offers a direct message; picked people leave the results", async () => {
        const chat = fakeChat(["a"]);
        const c = await make(chat);
        await c.onView("group");
        expect(c.canCreateGroup()).toBe(false);
        c.onPerson(c.state.recent[0]);
        expect(c.canCreateGroup()).toBe(false);
        expect(c.shownPeople().map((p: any) => p.name)).toEqual(["Bob"]);
        await c.onCreateGroup();
        expect(chat.createGroup).not.toHaveBeenCalled();
        await c.onWriteToPicked();
        expect(chat.startDirect).toHaveBeenCalledWith(expect.anything(), 1);
        c.navigate.mockClear();
        c.onPerson(c.state.recent[1]);
        expect(c.canCreateGroup()).toBe(true);
        c.onGroupName(input(" Team "));
        await c.onCreateGroup();
        expect(chat.createGroup).toHaveBeenCalledWith(expect.anything(), [1, 2], "Team");
        expect(c.navigate).toHaveBeenCalledWith("/chat/a/-50");
    });

    it("a channel needs a name and starts on the default access group", async () => {
        const chat = fakeChat(["a"]);
        const c = await make(chat);
        await c.onView("channel");
        expect(c.state.groupId).toBe(11);
        expect(c.canCreateChannel()).toBe(false);
        await c.onCreateChannel();
        expect(chat.createChannel).not.toHaveBeenCalled();
        c.onChannelName(input("  news "));
        await c.onCreateChannel();
        expect(chat.createChannel).toHaveBeenCalledWith(expect.anything(), "news", 11);
        c.onAccessChange(input("false"));
        expect(c.state.groupId).toBe(false);
        c.onAccessChange(input("12"));
        expect(c.state.groupId).toBe(12);
        expect(c.navigate).toHaveBeenCalledWith("/chat/a/60");
    });

    it("lists the channels to join and joins one; offline shows a note", async () => {
        const chat = fakeChat(["a"]);
        const c = await make(chat);
        await c.onView("join");
        expect(c.state.joinable.map((x: any) => x.name)).toEqual(["general"]);
        await c.onJoin(c.state.joinable[0]);
        expect(chat.join).toHaveBeenCalledWith(expect.anything(), 9, "general");
        expect(c.navigate).toHaveBeenCalledWith("/chat/a/9");
        chat.people.joinableChannels.mockResolvedValue({ channels: [], offline: true });
        await c.onView("join");
        expect(c.state.offline).toBe(true);
    });
});

describe("ChatNewComponent fixes", () => {
    it("a failed access groups read blocks the channel creation and is retried", async () => {
        const chat = fakeChat(["a"]);
        chat.people.accessGroups.mockRejectedValueOnce(new Error("down"));
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const c = await make(chat);
        await c.onView("channel");
        c.onChannelName(input("news"));
        expect(c.canCreateChannel()).toBe(false);
        await c.onCreateChannel();
        expect(chat.createChannel).not.toHaveBeenCalled();
        await c.onView("people");
        await c.onView("channel");
        expect(c.canCreateChannel()).toBe(true);
        expect(c.state.groupId).toBe(11);
    });

    it("keeps the chosen access group across tabs and resets it on a server change", async () => {
        const chat = fakeChat(["a", "b"]);
        const c = await make(chat);
        await c.onView("channel");
        c.onAccessChange(input("12"));
        await c.onView("people");
        await c.onView("channel");
        expect(c.state.groupId).toBe(12);
        expect(chat.people.accessGroups).toHaveBeenCalledTimes(1);
        await c.onServer("b");
        expect(chat.people.accessGroups).toHaveBeenCalledTimes(2);
        expect(c.state.groupId).toBe(11);
    });

    it("clears the channels to join on a server change", async () => {
        const chat = fakeChat(["a", "b"]);
        const c = await make(chat);
        await c.onView("join");
        chat.people.joinableChannels.mockResolvedValue({ channels: [], offline: true });
        await c.onServer("b");
        expect(c.state.joinable).toEqual([]);
        expect(c.state.offline).toBe(true);
    });

    it("a double tap picks a person once", async () => {
        const c = await make(fakeChat(["a"]));
        await c.onView("group");
        c.onPerson(c.state.recent[0]);
        c.onPerson(c.state.recent[0]);
        expect(c.state.picked).toHaveLength(1);
        expect(c.canCreateGroup()).toBe(false);
        c.state.picked = [c.state.recent[0], c.state.recent[0]];
        expect(c.canCreateGroup()).toBe(false);
    });

    it("a double tap on an action runs it once", async () => {
        const chat = fakeChat(["a"]);
        const c = await make(chat);
        await Promise.all([c.onPerson(c.state.recent[0]), c.onPerson(c.state.recent[0])]);
        expect(chat.startDirect).toHaveBeenCalledTimes(1);
    });

    it("typing while the recent list loads, then clearing, shows the recent people", async () => {
        const chat = fakeChat(["a"]);
        let release: (v: any) => void = () => {};
        const c = await make(chat);
        chat.people.recentPeople.mockReturnValue(new Promise((res) => { release = res; }));
        const loading = c.onServer("a");
        c.onQueryInput(input("x"));
        c.onQueryInput(input(""));
        release([person(1, "Alice")]);
        await loading;
        expect(c.shownPeople().map((p: any) => p.name)).toEqual(["Alice"]);
    });

    it("a search answered after a newer keystroke is dropped", async () => {
        const chat = fakeChat(["a"]);
        let release: (v: any) => void = () => {};
        chat.people.searchPeople.mockReturnValue(new Promise((res) => { release = res; }));
        const c = await make(chat);
        const pending = c.search("old");
        c.onQueryInput(input(""));
        release([person(3, "Carol")]);
        await pending;
        expect(c.state.results).toEqual([]);
    });

    it("unmounting cancels a pending search", async () => {
        vi.useFakeTimers();
        const chat = fakeChat(["a"]);
        const c = await make(chat);
        c.onQueryInput(input("car"));
        c._searchGen++;
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2);
        expect(chat.people.searchPeople).not.toHaveBeenCalled();
    });

    it("a failed init offers a retry", async () => {
        const chat = fakeChat(["a"]);
        chat.sources.mockRejectedValueOnce(new Error("db"));
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const c = await make(chat);
        expect(c.state.initFailed).toBe(true);
        await c.init();
        expect(c.state.initFailed).toBe(false);
        expect(c.state.serverId).toBe("a");
    });
});

describe("ChatListComponent new button", () => {
    it("opens the new conversation screen", () => {
        const c = new (ChatListComponent as any)();
        c.navigate = vi.fn();
        c.onNew();
        expect(c.navigate).toHaveBeenCalledWith("/chat/new");
    });
});
