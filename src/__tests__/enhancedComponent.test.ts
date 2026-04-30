import { describe, it, expect, vi } from "vitest";

vi.mock("@odoo/owl", () => ({
    Component: class { public env: any = {}; },
    EventBus: class extends EventTarget {},
}));

import { EnhancedComponent } from "../js/enhancedComponent";
import { Events } from "../constants/events";

class FakeBus extends EventTarget {}
class TestComponent extends EnhancedComponent {}

function makeWired() {
    const c = new (TestComponent as any)();
    const env = {
        router: { _: "router" },
        eventBus: new FakeBus(),
        appService: { _: "app" },
        intentService: { _: "intent" },
        noteService: { _: "note" },
        databaseService: { _: "db" },
        syncService: { _: "sync" },
        notificationService: { _: "notif" },
        serverService: { _: "server" },
        deploymentService: { _: "deploy" },
        transcriptionService: { _: "trans" },
        processService: { _: "proc" },
        tagService: { _: "tag" },
    };
    c.env = env;
    return { c, env };
}

describe("EnhancedComponent", () => {
    it("exposes every env service through a typed getter", () => {
        const { c, env } = makeWired();
        expect(c.router).toBe(env.router);
        expect(c.eventBus).toBe(env.eventBus);
        expect(c.appService).toBe(env.appService);
        expect(c.intentService).toBe(env.intentService);
        expect(c.noteService).toBe(env.noteService);
        expect(c.databaseService).toBe(env.databaseService);
        expect(c.syncService).toBe(env.syncService);
        expect(c.notificationService).toBe(env.notificationService);
        expect(c.serverService).toBe(env.serverService);
        expect(c.deploymentService).toBe(env.deploymentService);
        expect(c.transcriptionService).toBe(env.transcriptionService);
        expect(c.processService).toBe(env.processService);
        expect(c.tagService).toBe(env.tagService);
    });

    describe("navigate", () => {
        it("dispatches a ROUTER_NAVIGATION CustomEvent with the url in detail", () => {
            const { c, env } = makeWired();
            const handler = vi.fn();
            env.eventBus.addEventListener(Events.ROUTER_NAVIGATION, handler);
            c.navigate("/notes");
            expect(handler).toHaveBeenCalledTimes(1);
            const ev = handler.mock.calls[0][0] as CustomEvent;
            expect(ev.detail.url).toBe("/notes");
        });
    });
});
