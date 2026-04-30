import { describe, it, expect } from "vitest";
import { helpers } from "../js/helpers";

describe("helpers.formatDate", () => {
    it("formats an ISO string in fr-CA with day/month/year and HH-MM-SS", () => {
        const out = helpers.formatDate("2026-04-29T14:05:09Z");
        // fr-CA renders the time as 'HH h MM min SS s' — assert all three.
        expect(out).toMatch(/2026/);
        expect(out).toMatch(/\d{1,2}/);
        expect(out).toMatch(/\d{1,2}\s*h\s*\d{2}\s*min\s*\d{2}\s*s/);
    });

    it("uses 24-hour clock (no AM/PM)", () => {
        const out = helpers.formatDate("2026-04-29T23:00:00Z");
        expect(out.toLowerCase()).not.toMatch(/am|pm/);
    });

    it("accepts a numeric timestamp", () => {
        const out = helpers.formatDate(0);
        expect(out).toMatch(/\d{4}/);  // year present
    });
});
