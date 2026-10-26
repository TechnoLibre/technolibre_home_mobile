import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";

import {
    OptionsLicensesComponent,
    THIRD_PARTY_NOTICES,
} from "../components/options/licenses/options_licenses_component";

function make() {
    const c = new (OptionsLicensesComponent as any)();
    c.setup();
    return c;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("OptionsLicensesComponent", () => {
    it("starts collapsed and toggles", () => {
        const c = make();
        expect(c.state.expanded).toBe(false);
        c.toggleExpanded();
        expect(c.state.expanded).toBe(true);
    });

    it("names the MP3 encoder under LGPL-3.0 with a source link", () => {
        const lame = THIRD_PARTY_NOTICES.find((n) => n.name === "@breezystack/lamejs");
        expect(lame?.license).toBe("LGPL-3.0");
        expect(lame?.sourceUrl).toMatch(/^https:\/\//);
    });

    it("acknowledges LAME with a link to its site, as the authors' notice asks", async () => {
        const lame = THIRD_PARTY_NOTICES[0];
        expect(lame.authorsNotice).toContain("lame.sourceforge.net");
        expect(lame.basedOn).toEqual({ name: "LAME", url: "https://lame.sourceforge.net" });
        const source = readFileSync("src/components/options/licenses/options_licenses_component.ts", "utf8");
        expect(source).toMatch(/t-att-href="notice\.basedOn\.url"/);
        const en = (await import("../i18n/en")).translations;
        const fr = (await import("../i18n/fr")).translations;
        expect(en["options.licenses_based_on"]).toContain("{name}");
        expect(fr["options.licenses_based_on"]).toContain("{name}");
    });

    it("carries the licence text the package ships", () => {
        const lame = THIRD_PARTY_NOTICES[0];
        expect(lame.authorsNotice).toContain("LGPL");
        expect(lame.licenseText).toContain("GNU LESSER GENERAL PUBLIC LICENSE");
        expect(lame.licenseText).toContain("Version 3, 29 June 2007");
        expect(lame.baseLicenseText).toContain("GNU GENERAL PUBLIC LICENSE");
        expect(lame.baseLicenseText).toContain("Version 3, 29 June 2007");
    });

    it("shows the GPL text only on request", () => {
        const c = make();
        expect(c.state.base).toBe(false);
        c.toggleBase();
        expect(c.state.base).toBe(true);
    });

    it("lists the version the app depends on", () => {
        const pkg = JSON.parse(readFileSync("package.json", "utf8"));
        const wanted = pkg.dependencies["@breezystack/lamejs"];
        expect(wanted.replace(/^[\^~]/, "")).toBe(THIRD_PARTY_NOTICES[0].version);
    });

    it("has its strings in both languages", async () => {
        const en = (await import("../i18n/en")).translations;
        const fr = (await import("../i18n/fr")).translations;
        for (const key of ["options.licenses", "options.licenses_intro", "options.licenses_use", "options.licenses_source", "options.licenses_authors", "options.licenses_base"]) {
            expect(en[key]).toBeTruthy();
            expect(fr[key]).toBeTruthy();
        }
    });
});
