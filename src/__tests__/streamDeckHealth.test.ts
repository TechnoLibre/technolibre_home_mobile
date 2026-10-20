import { describe, it, expect } from "vitest";
import {
    HEALTH_CHECK_AFTER_HIDDEN_MS,
    planSickRestart,
    shouldCheckHealth,
} from "../services/streamDeckHealth";
import type { DeckHealth } from "../plugins/streamDeckPlugin";

function deck(over: Partial<DeckHealth> = {}): DeckHealth {
    return {
        deviceName: "/dev/bus/usb/001/002",
        deckId: "TESTSERIAL01",
        hasPermission: true,
        open: true,
        reopening: false,
        readerAlive: true,
        writerAlive: true,
        writeFailuresInARow: 0,
        controlFailuresInARow: 0,
        controlPipeOk: true,
        msSinceReport: 0,
        lastCloseReason: "",
        sick: false,
        sickReason: "",
        ...over,
    };
}

describe("shouldCheckHealth", () => {
    it("skips a brief hide and checks after a longer one", () => {
        expect(shouldCheckHealth(0)).toBe(false);
        expect(shouldCheckHealth(HEALTH_CHECK_AFTER_HIDDEN_MS)).toBe(false);
        expect(shouldCheckHealth(HEALTH_CHECK_AFTER_HIDDEN_MS + 1)).toBe(true);
    });
});

describe("planSickRestart", () => {
    it("restarts nothing when every deck is healthy", () => {
        const plan = planSickRestart([deck(), deck({ deviceName: "/dev/bus/usb/001/003" })]);
        expect(plan.deviceNames).toEqual([]);
        expect(plan.deckIds).toEqual([]);
    });

    it("restarts only the sick deck, by its device name", () => {
        const plan = planSickRestart([
            deck(),
            deck({
                deviceName: "/dev/bus/usb/001/003", deckId: "TESTSERIAL02",
                readerAlive: false, sick: true, sickReason: "reader_ended",
            }),
        ]);
        expect(plan.deviceNames).toEqual(["/dev/bus/usb/001/003"]);
        expect(plan.deckIds).toEqual(["TESTSERIAL02"]);
        expect(plan.reasons).toEqual(["/dev/bus/usb/001/003: reader_ended"]);
    });

    it("restarts a deck with no session and no deckId by device name only", () => {
        const plan = planSickRestart([deck({
            deckId: "", open: false, readerAlive: false, writerAlive: false,
            sick: true, sickReason: "no_session",
        })]);
        expect(plan.deviceNames).toEqual(["/dev/bus/usb/001/002"]);
        expect(plan.deckIds).toEqual([]);
    });

    it("trusts the plugin's verdict, not its own reading of the signals", () => {
        // Failures below the plugin's threshold, or a pending automatic
        // reopen, are reported healthy: the resume leaves them alone.
        const plan = planSickRestart([
            deck({ writeFailuresInARow: 1, controlFailuresInARow: 1 }),
            deck({ deviceName: "/dev/bus/usb/001/003", open: false, reopening: true }),
        ]);
        expect(plan.deviceNames).toEqual([]);
    });

    it("lists a device reported twice once", () => {
        const sick = deck({ sick: true, sickReason: "writes_failing" });
        expect(planSickRestart([sick, sick]).deviceNames).toEqual(["/dev/bus/usb/001/002"]);
    });

    it("restarts nothing on a malformed report", () => {
        expect(planSickRestart(undefined).deviceNames).toEqual([]);
        expect(planSickRestart(null).deviceNames).toEqual([]);
        expect(planSickRestart({} as any).deviceNames).toEqual([]);
        expect(planSickRestart([null as any, deck({ deviceName: "", sick: true })])
            .deviceNames).toEqual([]);
    });
});
