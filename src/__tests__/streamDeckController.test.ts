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
            getSessionHealth: vi.fn().mockResolvedValue({ decks: [] }),
            keyListenerReady: vi.fn().mockResolvedValue({ delivered: 0, dropped: 0 }),
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

import { StreamDeckController, galleryKeyFor } from "../services/streamDeckController";
import { Events } from "../constants/events";

const DECK = {
    deckId: "AL01",
    model: "mk2",
    rows: 3,
    cols: 5,
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
        mockPlugin.getSessionHealth.mockResolvedValue({ decks: [] });
        mockPlugin.keyListenerReady.mockResolvedValue({ delivered: 0, dropped: 0 });
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

        // deckConnected carries the deck's info: the controller caches the
        // deck from it, probed through the gallery shortcut (key `cols`),
        // which only answers for a cached deck.
        it("caches a deck from the deckConnected info without getDeckInfo", async () => {
            const { bus, trigger } = makeBus();
            const ctrl = new StreamDeckController(bus, makeNoteService());
            visibilityState = "hidden";
            await ctrl.start();
            await listeners["deckConnected"]({ deckId: "AL01", info: DECK });
            expect(mockPlugin.getDeckInfo).not.toHaveBeenCalled();
            listeners["keyChanged"]({ deckId: "AL01", key: 5, pressed: true });
            expect(trigger).toHaveBeenCalledWith(
                Events.ROUTER_NAVIGATION, { url: "/applications/gallery" },
            );
        });

        it("falls back to getDeckInfo when deckConnected has no info", async () => {
            mockPlugin.getDeckInfo.mockResolvedValue(DECK);
            const { bus, trigger } = makeBus();
            const ctrl = new StreamDeckController(bus, makeNoteService());
            visibilityState = "hidden";
            await ctrl.start();
            await listeners["deckConnected"]({ deckId: "AL01" });
            expect(mockPlugin.getDeckInfo).toHaveBeenCalledWith({ deckId: "AL01" });
            listeners["keyChanged"]({ deckId: "AL01", key: 5, pressed: true });
            expect(trigger).toHaveBeenCalledWith(
                Events.ROUTER_NAVIGATION, { url: "/applications/gallery" },
            );
        });

        // The plugin holds presses until keyListenerReady and delivers
        // them through keyChanged: the handler must exist by then.
        it("calls keyListenerReady once keyChanged is subscribed", async () => {
            let subscribedAtReady = false;
            mockPlugin.keyListenerReady.mockImplementation(async () => {
                subscribedAtReady = typeof listeners["keyChanged"] === "function";
                return { delivered: 0, dropped: 0 };
            });
            const ctrl = new StreamDeckController({ trigger: vi.fn() }, makeNoteService());
            visibilityState = "hidden";
            await ctrl.start();
            expect(mockPlugin.keyListenerReady).toHaveBeenCalledTimes(1);
            expect(subscribedAtReady).toBe(true);
        });

        it("acts on a press the plugin delivers at keyListenerReady", async () => {
            mockPlugin.keyListenerReady.mockImplementation(async () => {
                listeners["keyChanged"]({ deckId: "AL01", key: 0, pressed: true });
                listeners["keyChanged"]({ deckId: "AL01", key: 0, pressed: false });
                return { delivered: 2, dropped: 0 };
            });
            const { bus, trigger } = makeBus();
            const ctrl = new StreamDeckController(bus, makeNoteService("held-1"));
            visibilityState = "hidden";
            await ctrl.start();
            expect(trigger).toHaveBeenCalledWith(
                Events.ROUTER_NAVIGATION, { url: "/note/held-1" },
            );
        });

        it("survives a keyListenerReady rejection", async () => {
            mockPlugin.keyListenerReady.mockRejectedValue(new Error("not implemented"));
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
            const ctrl = new StreamDeckController({ trigger: vi.fn() }, makeNoteService());
            visibilityState = "hidden";
            await expect(ctrl.start()).resolves.toBeUndefined();
            await Promise.resolve();
            expect(warn).toHaveBeenCalledWith(
                "[streamdeck] keyListenerReady:", expect.any(Error),
            );
            warn.mockRestore();
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

        it("debounces rapid presses to ≤1 per 150 ms (same key)", async () => {
            vi.useFakeTimers();
            // Avoid 0 — controller's initial lastPressAt is 0 too.
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

        /** Start with DECK (and `extra`) known, hide at 2000, show at
         *  10 000: a hide longer than the health-check threshold. */
        async function longHide(extra: any[] = []) {
            vi.useFakeTimers();
            vi.setSystemTime(1000);
            mockPlugin.listDecks.mockResolvedValue({ decks: [DECK, ...extra] });
            const ctrl = new StreamDeckController({ trigger: vi.fn() }, makeNoteService());
            ctrl.setCameraStreaming(true);
            visibilityState = "hidden";
            await ctrl.start();
            mockPlugin.restartSessions.mockClear();
            mockPlugin.setBrightness.mockClear();

            visibilityState = "hidden";
            vi.setSystemTime(2000);
            visibilityCb!();
            mockPlugin.setBrightness.mockClear();

            visibilityState = "visible";
            vi.setSystemTime(10_000);
            visibilityCb!();
            await vi.runAllTimersAsync();
            return ctrl;
        }

        function health(deviceName: string, deckId: string, sickReason = "") {
            return {
                deviceName, deckId, hasPermission: true, open: true,
                reopening: false, readerAlive: sickReason !== "reader_ended",
                writerAlive: true, writeFailuresInARow: 0,
                controlFailuresInARow: 0, controlPipeOk: true,
                lastCloseReason: "",
                sick: sickReason !== "", sickReason,
            };
        }

        it("after a long hide, healthy decks are restored, not restarted", async () => {
            mockPlugin.getSessionHealth.mockResolvedValue({
                decks: [health("/dev/bus/usb/001/002", "AL01")],
            });
            await longHide();
            expect(mockPlugin.getSessionHealth).toHaveBeenCalledTimes(1);
            expect(mockPlugin.restartSessions).not.toHaveBeenCalled();
            expect(mockPlugin.setBrightness).toHaveBeenCalledWith(
                { deckId: "AL01", percent: 50 },
            );
        });

        it("after a long hide, only the sick deck is restarted", async () => {
            const other = { ...DECK, deckId: "AL02" };
            mockPlugin.getSessionHealth.mockResolvedValue({
                decks: [
                    health("/dev/bus/usb/001/002", "AL01"),
                    health("/dev/bus/usb/001/003", "AL02", "reader_ended"),
                ],
            });
            await longHide([other]);
            expect(mockPlugin.restartSessions).toHaveBeenCalledTimes(1);
            expect(mockPlugin.restartSessions).toHaveBeenCalledWith(
                { deviceNames: ["/dev/bus/usb/001/003"] },
            );
            // The healthy deck is restored here; the restarted one by
            // deckConnected once it reopens.
            expect(mockPlugin.setBrightness).toHaveBeenCalledWith(
                { deckId: "AL01", percent: 50 },
            );
            expect(mockPlugin.setBrightness).not.toHaveBeenCalledWith(
                { deckId: "AL02", percent: 50 },
            );
        });

        it("a failed health query restarts nothing and still restores", async () => {
            mockPlugin.getSessionHealth.mockRejectedValue(new Error("not_implemented"));
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
            await longHide();
            warn.mockRestore();
            expect(mockPlugin.restartSessions).not.toHaveBeenCalled();
            expect(mockPlugin.setBrightness).toHaveBeenCalledWith(
                { deckId: "AL01", percent: 50 },
            );
        });

        it("a brief hide does not query health", async () => {
            vi.useFakeTimers();
            vi.setSystemTime(1000);
            mockPlugin.listDecks.mockResolvedValue({ decks: [DECK] });
            const ctrl = new StreamDeckController({ trigger: vi.fn() }, makeNoteService());
            ctrl.setCameraStreaming(true);
            visibilityState = "hidden";
            await ctrl.start();
            visibilityCb!();
            visibilityState = "visible";
            vi.setSystemTime(3000);
            visibilityCb!();
            expect(mockPlugin.getSessionHealth).not.toHaveBeenCalled();
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
            // Stub canvas just enough for _renderTile to encode a tile.
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
                    toDataURL: () => "data:image/jpeg;base64,AQI=",
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
                    toDataURL: () => "data:image/jpeg;base64,AQ==",
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

        it("debounces presses on the same key but not across keys", async () => {
            // Per-key budget: pressing key 1 then key 2 within 150 ms
            // must fire both. Sharing the budget across keys was the
            // bug behind the user-visible "I have to press multiple
            // times" report — pressing Note (key 0) then Audio (key 2)
            // dropped the Audio because key 0 had just consumed it.
            vi.useFakeTimers();
            vi.setSystemTime(10_000);
            const { bus, trigger } = makeBus();
            const ctrl = new StreamDeckController(bus, makeNoteService());
            visibilityState = "hidden";
            await ctrl.start();
            await ctrl.setNoteActive(true);
            trigger.mockClear();

            // Two different keys within 50 ms — both must fire.
            listeners["keyChanged"]({ deckId: "AL01", key: 1, pressed: true });
            vi.setSystemTime(10_050);
            listeners["keyChanged"]({ deckId: "AL01", key: 2, pressed: true });
            const fired = trigger.mock.calls.map((c: any) => c[0]);
            expect(fired).toContain("streamdeck_add_video");
            expect(fired).toContain("streamdeck_add_audio");

            // Same key (1) twice within the 150 ms window — second
            // press is dropped. The earlier accepted press of key 1
            // was at 10_000; 10_100 is 100 ms later, still < 150.
            trigger.mockClear();
            vi.setSystemTime(10_100);
            listeners["keyChanged"]({ deckId: "AL01", key: 1, pressed: true });
            const fired2 = trigger.mock.calls.map((c: any) => c[0]);
            expect(fired2).not.toContain("streamdeck_add_video");
        });

        it("PAGE_ACTIVE fired before start() resolves still flips noteActive", async () => {
            // Regression: previously the bus listener was added at the
            // tail of start(), past three async addListener calls. A
            // user pressing Note (or otherwise navigating to a note)
            // before start() finished landed PAGE_ACTIVE on an empty
            // bus and the keys stayed blank until they re-mounted.
            const { bus, emit } = makeBus();
            const ctrl = new StreamDeckController(bus, makeNoteService());
            // Listener must be live BEFORE start() — fire active=true
            // and verify noteActive flips immediately, even though
            // start() never ran.
            emit("streamdeck_note_page_active", { active: true });
            await Promise.resolve();
            // _isHidden() returns false in this test setup so the paint
            // path runs; with no decks registered yet, the loop is a
            // no-op but noteActive must still be true.
            expect((ctrl as any).noteActive).toBe(true);
        });

        it("Note-then-Audio works without delay (regression for the user-reported bug)", async () => {
            vi.useFakeTimers();
            vi.setSystemTime(10_000);
            const { bus, trigger } = makeBus();
            const ctrl = new StreamDeckController(bus, makeNoteService());
            visibilityState = "hidden";
            await ctrl.start();
            await ctrl.setNoteActive(true);
            trigger.mockClear();

            // Tap Note then immediately Audio — Audio must register.
            listeners["keyChanged"]({ deckId: "AL01", key: 0, pressed: true });
            vi.setSystemTime(10_020);
            listeners["keyChanged"]({ deckId: "AL01", key: 2, pressed: true });
            const fired = trigger.mock.calls.map((c: any) => c[0]);
            expect(fired).toContain("routernav");
            expect(fired).toContain("streamdeck_add_audio");
        });

        it("press on key 5 navigates to /applications/gallery on a 5x3 deck", async () => {
            mockPlugin.listDecks.mockResolvedValue({ decks: [DECK] });
            const { bus, trigger } = makeBus();
            const ctrl = new StreamDeckController(bus, makeNoteService());
            visibilityState = "hidden";
            await ctrl.start();
            trigger.mockClear();
            listeners["keyChanged"]({ deckId: "AL01", key: 5, pressed: true });
            expect(trigger).toHaveBeenCalledWith(
                Events.ROUTER_NAVIGATION, { url: "/applications/gallery" },
            );
        });

        it("on an 8x4 deck the shortcut is key 8, and key 5 stays inert", async () => {
            const xl = { ...DECK, deckId: "XL01", model: "xl", rows: 4, cols: 8, keyCount: 32 };
            mockPlugin.listDecks.mockResolvedValue({ decks: [xl] });
            const { bus, trigger } = makeBus();
            const ctrl = new StreamDeckController(bus, makeNoteService());
            visibilityState = "hidden";
            await ctrl.start();
            trigger.mockClear();
            listeners["keyChanged"]({ deckId: "XL01", key: 5, pressed: true });
            expect(trigger).not.toHaveBeenCalled();
            listeners["keyChanged"]({ deckId: "XL01", key: 8, pressed: true });
            expect(trigger).toHaveBeenCalledWith(
                Events.ROUTER_NAVIGATION, { url: "/applications/gallery" },
            );
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

    describe("tile encoding", () => {
        /** Canvas stub that records the MIME type each tile is encoded to
         *  and answers with bytes carrying that type's signature. */
        function stubCanvas(mimes: string[]) {
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
                    toDataURL: (mime: string) => {
                        mimes.push(mime);
                        const sig = mime === "image/png"
                            ? [0x89, 0x50, 0x4e, 0x47] : [0xff, 0xd8, 0xff];
                        return `data:${mime};base64,`
                            + btoa(String.fromCharCode(...sig));
                    },
                }),
            });
        }

        const MINI = {
            deckId: "MINI1",
            model: "mini",
            rows: 2,
            cols: 3,
            keyCount: 6,
            keyImage: { w: 80, h: 80, format: "bmp_bgr_rot270", rotation: 0 },
        };

        it("sends PNG to a BMP deck, whose encoder refuses anything else", async () => {
            mockPlugin.listDecks.mockResolvedValue({ decks: [MINI] });
            const mimes: string[] = [];
            visibilityState = "visible";
            stubCanvas(mimes);
            const ctrl = new StreamDeckController({ trigger: vi.fn() }, makeNoteService());
            await ctrl.start();
            await ctrl.setNoteActive(true);

            const calls = mockPlugin.setKeyImage.mock.calls.map((c: any) => c[0]);
            // Note on key 0, the gallery shortcut on key 5, keys 1-3.
            expect(calls.map((c: any) => c.key).sort()).toEqual(
                expect.arrayContaining([0, 1, 2, 3, 5]),
            );
            expect(mimes.length).toBeGreaterThan(0);
            expect(new Set(mimes)).toEqual(new Set(["image/png"]));
            for (const c of calls) {
                expect(c.format).toBe("png");
                // PNG signature, as the plugin's BMP encoder checks it.
                expect(atob(c.bytes).charCodeAt(0)).toBe(0x89);
            }
        });

        it("sends JPEG to a JPEG deck", async () => {
            mockPlugin.listDecks.mockResolvedValue({ decks: [DECK] });
            const mimes: string[] = [];
            visibilityState = "visible";
            stubCanvas(mimes);
            const ctrl = new StreamDeckController({ trigger: vi.fn() }, makeNoteService());
            await ctrl.start();

            expect(mimes.length).toBeGreaterThan(0);
            expect(new Set(mimes)).toEqual(new Set(["image/jpeg"]));
            for (const c of mockPlugin.setKeyImage.mock.calls) {
                expect(c[0].format).toBe("jpeg");
            }
        });
    });

    describe("galleryKeyFor", () => {
        it("puts the shortcut directly below key 0", () => {
            expect(galleryKeyFor({ rows: 3, cols: 5, keyCount: 15 })).toBe(5);
            expect(galleryKeyFor({ rows: 4, cols: 8, keyCount: 32 })).toBe(8);
            expect(galleryKeyFor({ rows: 2, cols: 4, keyCount: 8 })).toBe(4);
        });

        it("falls back to the last key when below key 0 is a note-page key", () => {
            // Mini 3x2: key 3 is the Location tile on a note page.
            expect(galleryKeyFor({ rows: 2, cols: 3, keyCount: 6 })).toBe(5);
        });

        it("has no shortcut on a single row or a keyless deck", () => {
            expect(galleryKeyFor({ rows: 1, cols: 3, keyCount: 3 })).toBeNull();
            expect(galleryKeyFor({ rows: 0, cols: 0, keyCount: 0 })).toBeNull();
        });
    });

    describe("gallery remote mode", () => {
        function makeImages(n: number) {
            return Array.from({ length: n }, (_, i) => ({
                url: `cap://thumb/${i}.jpg`,
                index: i,
            }));
        }

        async function bootGalleryCtrl() {
            mockPlugin.listDecks.mockResolvedValue({ decks: [DECK] });
            const { bus, trigger, emit } = makeBus();
            const ctrl = new StreamDeckController(bus, makeNoteService());
            // _isHidden=true → setGalleryActive paint loop is a no-op,
            // letting us probe the state machine without canvas stubs.
            visibilityState = "hidden";
            await ctrl.start();
            // Prime the keyChanged handler with the deck cache via
            // listDecks; hidden=true means no paint side-effects.
            return { ctrl, trigger, emit };
        }

        it("STREAMDECK_GALLERY_PAGE_ACTIVE flips into remote mode", async () => {
            const { ctrl, emit } = await bootGalleryCtrl();
            emit("streamdeck_gallery_page_active", {
                active: true, images: makeImages(3),
            });
            await Promise.resolve();
            expect((ctrl as any).galleryActive).toBe(true);
            expect((ctrl as any).galleryImages.length).toBe(3);
            expect((ctrl as any).galleryPage).toBe(0);
        });

        it("thumb press fires STREAMDECK_GALLERY_OPEN with absolute index", async () => {
            const { trigger, emit } = await bootGalleryCtrl();
            emit("streamdeck_gallery_page_active", {
                active: true, images: makeImages(5),
            });
            await Promise.resolve();
            trigger.mockClear();
            // 15-key deck → thumbCount = 12. Key 2 maps to image 2 on
            // page 0.
            listeners["keyChanged"]({ deckId: "AL01", key: 2, pressed: true });
            expect(trigger).toHaveBeenCalledWith(
                "streamdeck_gallery_open", { index: 2 },
            );
        });

        it("back key (last) fires STREAMDECK_GALLERY_BACK", async () => {
            const { trigger, emit } = await bootGalleryCtrl();
            emit("streamdeck_gallery_page_active", {
                active: true, images: makeImages(3),
            });
            await Promise.resolve();
            trigger.mockClear();
            // 15-key deck → back key = 14.
            listeners["keyChanged"]({ deckId: "AL01", key: 14, pressed: true });
            expect(trigger).toHaveBeenCalledWith(
                "streamdeck_gallery_back", {},
            );
        });

        it("next/prev page keys flip galleryPage", async () => {
            // Pin fake time before the first press so debounce
            // accounting (lastPressAt) uses the same clock as the
            // subsequent setSystemTime calls.
            vi.useFakeTimers();
            vi.setSystemTime(20_000);
            const { ctrl, emit } = await bootGalleryCtrl();
            // 30 images → 3 pages of 12 (last page = 6 images).
            emit("streamdeck_gallery_page_active", {
                active: true, images: makeImages(30),
            });
            await Promise.resolve();
            // Next key = 13.
            listeners["keyChanged"]({ deckId: "AL01", key: 13, pressed: true });
            expect((ctrl as any).galleryPage).toBe(1);
            vi.setSystemTime(20_500);
            listeners["keyChanged"]({ deckId: "AL01", key: 13, pressed: true });
            expect((ctrl as any).galleryPage).toBe(2);
            // Cap at last page.
            vi.setSystemTime(21_000);
            listeners["keyChanged"]({ deckId: "AL01", key: 13, pressed: true });
            expect((ctrl as any).galleryPage).toBe(2);
            // Prev key = 12.
            vi.setSystemTime(21_500);
            listeners["keyChanged"]({ deckId: "AL01", key: 12, pressed: true });
            expect((ctrl as any).galleryPage).toBe(1);
        });

        it("thumb index uses page offset", async () => {
            const { trigger, ctrl, emit } = await bootGalleryCtrl();
            emit("streamdeck_gallery_page_active", {
                active: true, images: makeImages(20),
            });
            await Promise.resolve();
            (ctrl as any).galleryPage = 1;
            trigger.mockClear();
            // Page 1, key 0 → image 12.
            listeners["keyChanged"]({ deckId: "AL01", key: 0, pressed: true });
            expect(trigger).toHaveBeenCalledWith(
                "streamdeck_gallery_open", { index: 12 },
            );
        });

        it("note key 0 navigation suppressed while gallery active", async () => {
            const { trigger, emit } = await bootGalleryCtrl();
            emit("streamdeck_gallery_page_active", {
                active: true, images: makeImages(3),
            });
            await Promise.resolve();
            trigger.mockClear();
            // Press key 0 — would normally fire ROUTER_NAVIGATION /note/<id>.
            // In gallery mode, key 0 is a thumb (image 0).
            listeners["keyChanged"]({ deckId: "AL01", key: 0, pressed: true });
            const events = trigger.mock.calls.map((c: any) => c[0]);
            expect(events).not.toContain("routernav");
            expect(events).toContain("streamdeck_gallery_open");
        });

        it("paints all 15 keys without waiting on an async canvas encoder", async () => {
            // A mobile WebView can defer toBlob() to an idle period and
            // force it only after 4 s on a static page; this stub never
            // calls back at all, so a paint that relies on it hangs.
            mockPlugin.listDecks.mockResolvedValue({ decks: [DECK] });
            const ctrl = new StreamDeckController({ trigger: vi.fn() }, makeNoteService());
            visibilityState = "hidden";
            await ctrl.start();
            const mimes: string[] = [];
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
                    toBlob: () => { /* never completes */ },
                    toDataURL: (mime: string) => {
                        mimes.push(mime);
                        return `data:${mime};base64,/9j/AA==`;
                    },
                }),
            });
            visibilityState = "visible";
            mockPlugin.setKeyImage.mockClear();

            const outcome = await Promise.race([
                ctrl.setGalleryActive(true, []).then(() => "done"),
                new Promise((r) => setTimeout(() => r("hung"), 200)),
            ]);

            expect(outcome).toBe("done");
            const calls = mockPlugin.setKeyImage.mock.calls.map((c: any) => c[0]);
            expect(calls.map((c: any) => c.key)).toEqual(
                Array.from({ length: 15 }, (_, i) => i),
            );
            for (const c of calls) {
                expect(c.format).toBe("jpeg");
                expect(c.bytes).toBe("/9j/AA==");
            }
            expect(new Set(mimes)).toEqual(new Set(["image/jpeg"]));
        });

        it("deactivation clears images and resets page", async () => {
            const { ctrl, emit } = await bootGalleryCtrl();
            emit("streamdeck_gallery_page_active", {
                active: true, images: makeImages(20),
            });
            await Promise.resolve();
            (ctrl as any).galleryPage = 1;
            emit("streamdeck_gallery_page_active", { active: false });
            await Promise.resolve();
            expect((ctrl as any).galleryActive).toBe(false);
            expect((ctrl as any).galleryImages.length).toBe(0);
            expect((ctrl as any).galleryPage).toBe(0);
        });
    });
});
