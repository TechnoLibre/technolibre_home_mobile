import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockPlugin, listeners } = vi.hoisted(() => {
    const ls: Record<string, (ev: any) => void> = {};
    return {
        mockPlugin: {
            listDecks: vi.fn().mockResolvedValue({ decks: [] }),
            getDeckInfo: vi.fn(),
            setBrightness: vi.fn().mockResolvedValue(undefined),
            setKeyImage: vi.fn().mockResolvedValue(undefined),
            restartSessions: vi.fn().mockResolvedValue(undefined),
            addListener: vi.fn(async (name: string, fn: any) => {
                ls[name] = fn;
                return { remove: vi.fn() };
            }),
        },
        listeners: ls,
    };
});

vi.mock("../plugins/streamDeckPlugin", () => ({
    StreamDeckPlugin: mockPlugin,
    DeckInfo: {} as any,
}));

import { StreamDeckController } from "../services/streamDeckController";
import { Events } from "../constants/events";

const DECK = {
    deckId: "AL01",
    model: "mk2",
    keyCount: 15,
    keyImage: { w: 72, h: 72, format: "jpeg", rotation: 0 },
};

function makeBus() {
    const trigger = vi.fn();
    const handlers = new Map<string, Set<(e: any) => void>>();
    const bus = {
        trigger,
        addEventListener(name: string, fn: (e: any) => void) {
            const set = handlers.get(name) ?? new Set();
            set.add(fn);
            handlers.set(name, set);
        },
        removeEventListener(name: string, fn: (e: any) => void) {
            handlers.get(name)?.delete(fn);
        },
    };
    function emit(name: string, detail: any) {
        for (const fn of handlers.get(name) ?? []) fn({ detail });
    }
    return { bus, trigger, emit };
}

function makeNoteService(id = "new-id-1") {
    return { getNewId: vi.fn(() => id) };
}

let visibilityCb: (() => void) | undefined;
let visibilityState: "visible" | "hidden" = "visible";

function stubBrowser() {
    visibilityCb = undefined;
    visibilityState = "visible";
    vi.stubGlobal("document", {
        get visibilityState() { return visibilityState; },
        addEventListener: vi.fn((evt: string, cb: any) => {
            if (evt === "visibilitychange") visibilityCb = cb;
        }),
        // _renderHome is suppressed in tests by stubbing canvas paths off:
        // we keep cameraStreaming=true on those tests, or pre-empt with
        // visibilityState='hidden' to bypass _renderHome entirely.
        createElement: vi.fn(),
    });
}

describe("StreamDeckController", () => {
    beforeEach(() => {
        Object.values(mockPlugin).forEach((m: any) => m.mockReset?.());
        mockPlugin.listDecks.mockResolvedValue({ decks: [] });
        mockPlugin.setBrightness.mockResolvedValue(undefined);
        mockPlugin.setKeyImage.mockResolvedValue(undefined);
        mockPlugin.restartSessions.mockResolvedValue(undefined);
        mockPlugin.addListener.mockImplementation(async (name: string, fn: any) => {
            listeners[name] = fn;
            return { remove: vi.fn() };
        });
        for (const k of Object.keys(listeners)) delete listeners[k];
        stubBrowser();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    describe("brightness cache", () => {
        it("clamps to 0–100 and remembers last value per deck", async () => {
            const { bus } = makeBus();
            const ctrl = new StreamDeckController(bus, makeNoteService());
            await ctrl.setBrightness("AL01", 250);
            expect(mockPlugin.setBrightness).toHaveBeenLastCalledWith(
                { deckId: "AL01", percent: 100 },
            );
            expect(ctrl.getBrightness("AL01")).toBe(100);
            await ctrl.setBrightness("AL01", -42);
            expect(mockPlugin.setBrightness).toHaveBeenLastCalledWith(
                { deckId: "AL01", percent: 0 },
            );
            expect(ctrl.getBrightness("AL01")).toBe(0);
            await ctrl.setBrightness("AL01", 60.6);
            expect(ctrl.getBrightness("AL01")).toBe(61);
        });

        it("returns the default for an unknown deck", () => {
            const ctrl = new StreamDeckController({ trigger: vi.fn() }, makeNoteService());
            expect(ctrl.getBrightness("none")).toBe(50);
        });
    });

    describe("start", () => {
        it("registers listeners for connect/disconnect/keyChanged", async () => {
            const ctrl = new StreamDeckController({ trigger: vi.fn() }, makeNoteService());
            // Stay hidden to skip _renderHome (canvas) entirely.
            visibilityState = "hidden";
            await ctrl.start();
            expect(mockPlugin.addListener).toHaveBeenCalledWith(
                "deckConnected", expect.any(Function),
            );
            expect(mockPlugin.addListener).toHaveBeenCalledWith(
                "deckDisconnected", expect.any(Function),
            );
            expect(mockPlugin.addListener).toHaveBeenCalledWith(
                "keyChanged", expect.any(Function),
            );
        });

        it("populates the deck cache from listDecks at boot", async () => {
            mockPlugin.listDecks.mockResolvedValue({ decks: [DECK] });
            const ctrl = new StreamDeckController({ trigger: vi.fn() }, makeNoteService());
            visibilityState = "hidden";
            await ctrl.start();
            // Indirect probe — disconnect callback empties the cache so
            // we use brightness restore (next test) elsewhere; here we
            // confirm listDecks was called once.
            expect(mockPlugin.listDecks).toHaveBeenCalledTimes(1);
        });

        it("survives listDecks rejection without throwing", async () => {
            mockPlugin.listDecks.mockRejectedValue(new Error("USB busted"));
            const ctrl = new StreamDeckController({ trigger: vi.fn() }, makeNoteService());
            visibilityState = "hidden";
            await expect(ctrl.start()).resolves.toBeUndefined();
        });
    });

    describe("keyChanged → router nav", () => {
        async function bootCtrl(noteId: string) {
            const { bus, trigger } = makeBus();
            const note = makeNoteService(noteId);
            const ctrl = new StreamDeckController(bus, note);
            visibilityState = "hidden";
            await ctrl.start();
            return { ctrl, trigger, note };
        }

        it("triggers ROUTER_NAVIGATION with /note/<newId> on key 0 press", async () => {
            const { trigger, note } = await bootCtrl("X");
            listeners["keyChanged"]({ deckId: "AL01", key: 0, pressed: true });
            expect(note.getNewId).toHaveBeenCalled();
            expect(trigger).toHaveBeenCalledWith(
                Events.ROUTER_NAVIGATION, { url: "/note/X" },
            );
        });

        it("ignores releases (pressed=false)", async () => {
            const { trigger } = await bootCtrl("Y");
            listeners["keyChanged"]({ deckId: "AL01", key: 0, pressed: false });
            expect(trigger).not.toHaveBeenCalled();
        });

        it("ignores keys other than 0", async () => {
            const { trigger } = await bootCtrl("Y");
            listeners["keyChanged"]({ deckId: "AL01", key: 1, pressed: true });
            expect(trigger).not.toHaveBeenCalled();
        });

        it("debounces rapid presses to ≤1 per 150 ms", async () => {
            vi.useFakeTimers();
            // Avoid 0 — controller's initial lastNotePressAt is 0 too.
            vi.setSystemTime(10_000);
            const { trigger } = await bootCtrl("Z");
            listeners["keyChanged"]({ deckId: "AL01", key: 0, pressed: true });
            vi.setSystemTime(10_050);
            listeners["keyChanged"]({ deckId: "AL01", key: 0, pressed: true });
            vi.setSystemTime(10_100);
            listeners["keyChanged"]({ deckId: "AL01", key: 0, pressed: true });
            expect(trigger).toHaveBeenCalledTimes(1);
            vi.setSystemTime(10_160);
            listeners["keyChanged"]({ deckId: "AL01", key: 0, pressed: true });
            expect(trigger).toHaveBeenCalledTimes(2);
        });

        it("suppresses navigation while camera-streaming is active", async () => {
            const { ctrl, trigger } = await bootCtrl("W");
            ctrl.setCameraStreaming(true);
            listeners["keyChanged"]({ deckId: "AL01", key: 0, pressed: true });
            expect(trigger).not.toHaveBeenCalled();
            ctrl.setCameraStreaming(false);
            listeners["keyChanged"]({ deckId: "AL01", key: 0, pressed: true });
            expect(trigger).toHaveBeenCalledTimes(1);
        });
    });

    describe("visibilitychange", () => {
        it("dims every connected deck to 0 on hidden", async () => {
            mockPlugin.listDecks.mockResolvedValue({ decks: [DECK] });
            const ctrl = new StreamDeckController({ trigger: vi.fn() }, makeNoteService());
            visibilityState = "hidden";
            await ctrl.start();
            mockPlugin.setBrightness.mockClear();
            visibilityState = "hidden";
            visibilityCb!();
            expect(mockPlugin.setBrightness).toHaveBeenCalledWith(
                { deckId: "AL01", percent: 0 },
            );
        });

        it("restores cached brightness on a brief visible (no restart)", async () => {
            vi.useFakeTimers();
            vi.setSystemTime(1000);
            mockPlugin.listDecks.mockResolvedValue({ decks: [DECK] });
            const ctrl = new StreamDeckController({ trigger: vi.fn() }, makeNoteService());
            // Start camera-streaming so _renderHome is skipped on visible.
            ctrl.setCameraStreaming(true);
            visibilityState = "hidden";
            await ctrl.start();
            await ctrl.setBrightness("AL01", 75);
            mockPlugin.setBrightness.mockClear();
            mockPlugin.restartSessions.mockClear();

            // Hide.
            visibilityState = "hidden";
            vi.setSystemTime(1100);
            visibilityCb!();

            // Brief flicker: <5 s.
            visibilityState = "visible";
            vi.setSystemTime(2500);
            visibilityCb!();

            expect(mockPlugin.restartSessions).not.toHaveBeenCalled();
            expect(mockPlugin.setBrightness).toHaveBeenCalledWith(
                { deckId: "AL01", percent: 75 },
            );
        });

        it("restartSessions on visible after >5 s sleep", async () => {
            vi.useFakeTimers();
            vi.setSystemTime(1000);
            mockPlugin.listDecks.mockResolvedValue({ decks: [DECK] });
            const ctrl = new StreamDeckController({ trigger: vi.fn() }, makeNoteService());
            ctrl.setCameraStreaming(true);
            visibilityState = "hidden";
            await ctrl.start();
            mockPlugin.restartSessions.mockClear();

            visibilityState = "hidden";
            vi.setSystemTime(2000);
            visibilityCb!();

            visibilityState = "visible";
            vi.setSystemTime(10_000);
            visibilityCb!();

            expect(mockPlugin.restartSessions).toHaveBeenCalledTimes(1);
        });
    });

    describe("deck cache & disconnect", () => {
        it("removes a deck from the cache on deckDisconnected", async () => {
            mockPlugin.listDecks.mockResolvedValue({ decks: [DECK] });
            const ctrl = new StreamDeckController({ trigger: vi.fn() }, makeNoteService());
            visibilityState = "hidden";
            await ctrl.start();
            // Send disconnect; subsequent visibility hide should NOT
            // dim that deck (no entries in cache).
            listeners["deckDisconnected"]({ deckId: "AL01" });
            mockPlugin.setBrightness.mockClear();
            visibilityState = "hidden";
            visibilityCb!();
            expect(mockPlugin.setBrightness).not.toHaveBeenCalled();
        });
    });

    describe("stop", () => {
        it("removes every registered listener", async () => {
            const remove = vi.fn();
            mockPlugin.addListener.mockImplementation(async (name: string, fn: any) => {
                listeners[name] = fn;
                return { remove };
            });
            const ctrl = new StreamDeckController({ trigger: vi.fn() }, makeNoteService());
            visibilityState = "hidden";
            await ctrl.start();
            await ctrl.stop();
            expect(remove).toHaveBeenCalledTimes(3);
        });
    });

    describe("note-page action keys", () => {
        it("paints keys 1-3 when setNoteActive(true)", async () => {
            mockPlugin.listDecks.mockResolvedValue({ decks: [DECK] });
            const ctrl = new StreamDeckController({ trigger: vi.fn() }, makeNoteService());
            // Mount-time visible (will paint key 0 once via _renderHome
            // — let it run, we filter by key below).
            visibilityState = "visible";
            // Stub canvas just enough for _renderTile to resolve a Blob.
            vi.stubGlobal("document", {
                get visibilityState() { return visibilityState; },
                addEventListener: vi.fn(),
                createElement: () => ({
                    width: 0, height: 0,
                    getContext: () => ({
                        translate: vi.fn(), rotate: vi.fn(),
                        fillRect: vi.fn(), fillText: vi.fn(),
                        set fillStyle(_: string) {},
                        set font(_: string) {},
                        set textAlign(_: string) {},
                        set textBaseline(_: string) {},
                    }),
                    toBlob: (cb: any) => cb(new Blob([new Uint8Array([1, 2])])),
                }),
            });
            await ctrl.start();
            mockPlugin.setKeyImage.mockClear();
            await ctrl.setNoteActive(true);
            const keysPainted = mockPlugin.setKeyImage.mock.calls
                .map((c: any) => c[0].key)
                .sort();
            expect(keysPainted).toEqual([1, 2, 3]);
        });

        it("blanks keys 1-3 when setNoteActive(false)", async () => {
            mockPlugin.listDecks.mockResolvedValue({ decks: [DECK] });
            const ctrl = new StreamDeckController({ trigger: vi.fn() }, makeNoteService());
            visibilityState = "visible";
            vi.stubGlobal("document", {
                get visibilityState() { return visibilityState; },
                addEventListener: vi.fn(),
                createElement: () => ({
                    width: 0, height: 0,
                    getContext: () => ({
                        translate: vi.fn(), rotate: vi.fn(),
                        fillRect: vi.fn(), fillText: vi.fn(),
                        set fillStyle(_: string) {},
                        set font(_: string) {},
                        set textAlign(_: string) {},
                        set textBaseline(_: string) {},
                    }),
                    toBlob: (cb: any) => cb(new Blob([new Uint8Array([1])])),
                }),
            });
            await ctrl.start();
            await ctrl.setNoteActive(true);
            mockPlugin.setKeyImage.mockClear();
            await ctrl.setNoteActive(false);
            // Same three keys repainted (with the blank tile).
            const keysPainted = mockPlugin.setKeyImage.mock.calls
                .map((c: any) => c[0].key)
                .sort();
            expect(keysPainted).toEqual([1, 2, 3]);
        });

        it("press on keys 1-3 fires the matching ADD_* event when active", async () => {
            const { bus, trigger } = makeBus();
            const ctrl = new StreamDeckController(bus, makeNoteService());
            visibilityState = "hidden";  // skip paints
            await ctrl.start();
            await ctrl.setNoteActive(true);
            trigger.mockClear();

            vi.useFakeTimers();
            vi.setSystemTime(10_000);
            listeners["keyChanged"]({ deckId: "AL01", key: 1, pressed: true });
            vi.setSystemTime(10_200);
            listeners["keyChanged"]({ deckId: "AL01", key: 2, pressed: true });
            vi.setSystemTime(10_400);
            listeners["keyChanged"]({ deckId: "AL01", key: 3, pressed: true });

            const fired = trigger.mock.calls.map((c: any) => c[0]);
            expect(fired).toContain("streamdeck_add_video");
            expect(fired).toContain("streamdeck_add_audio");
            expect(fired).toContain("streamdeck_add_location");
        });

        it("press on keys 1-3 is ignored when noteActive=false", async () => {
            const { bus, trigger } = makeBus();
            const ctrl = new StreamDeckController(bus, makeNoteService());
            visibilityState = "hidden";
            await ctrl.start();
            trigger.mockClear();
            listeners["keyChanged"]({ deckId: "AL01", key: 1, pressed: true });
            listeners["keyChanged"]({ deckId: "AL01", key: 2, pressed: true });
            listeners["keyChanged"]({ deckId: "AL01", key: 3, pressed: true });
            expect(trigger).not.toHaveBeenCalled();
        });

        it("camera-streaming suppresses press on keys 1-3", async () => {
            const { bus, trigger } = makeBus();
            const ctrl = new StreamDeckController(bus, makeNoteService());
            visibilityState = "hidden";
            await ctrl.start();
            await ctrl.setNoteActive(true);
            ctrl.setCameraStreaming(true);
            trigger.mockClear();
            listeners["keyChanged"]({ deckId: "AL01", key: 1, pressed: true });
            expect(trigger).not.toHaveBeenCalled();
        });

        it("debounce shared with key 0 (rapid mash drops the second press)", async () => {
            vi.useFakeTimers();
            vi.setSystemTime(10_000);
            const { bus, trigger } = makeBus();
            const ctrl = new StreamDeckController(bus, makeNoteService());
            visibilityState = "hidden";
            await ctrl.start();
            await ctrl.setNoteActive(true);
            trigger.mockClear();

            listeners["keyChanged"]({ deckId: "AL01", key: 1, pressed: true });
            vi.setSystemTime(10_050);
            listeners["keyChanged"]({ deckId: "AL01", key: 2, pressed: true });

            const fired = trigger.mock.calls.map((c: any) => c[0]);
            expect(fired).toContain("streamdeck_add_video");
            expect(fired).not.toContain("streamdeck_add_audio");
        });

        it("STREAMDECK_NOTE_PAGE_ACTIVE event drives setNoteActive", async () => {
            const { bus, trigger, emit } = makeBus();
            const ctrl = new StreamDeckController(bus, makeNoteService());
            visibilityState = "hidden";
            await ctrl.start();

            // Active=true via the bus → press on key 1 should now fire.
            emit("streamdeck_note_page_active", { active: true });
            // micro-flush — setNoteActive is async (paints).
            await Promise.resolve();
            await Promise.resolve();
            trigger.mockClear();
            listeners["keyChanged"]({ deckId: "AL01", key: 1, pressed: true });
            expect(trigger.mock.calls.map((c: any) => c[0]))
                .toContain("streamdeck_add_video");

            // Active=false via the bus → press on key 1 ignored.
            emit("streamdeck_note_page_active", { active: false });
            await Promise.resolve();
            trigger.mockClear();
            vi.setSystemTime(Date.now() + 1000);
            listeners["keyChanged"]({ deckId: "AL01", key: 1, pressed: true });
            expect(trigger).not.toHaveBeenCalled();
        });
    });
});
