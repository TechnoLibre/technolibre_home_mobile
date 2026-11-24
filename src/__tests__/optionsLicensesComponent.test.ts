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

    it("names the emoji data under the Unicode licence and the converted file under LGPL-3.0", async () => {
        const emoji = THIRD_PARTY_NOTICES.find((n) => n.name === "Unicode CLDR emoji data")!;
        expect(emoji.license).toBe("Unicode-DFS-2016");
        expect(emoji.sourceUrl).toBe("https://github.com/unicode-org/cldr");
        expect(emoji.licenseText.startsWith("UNICODE, INC. LICENSE AGREEMENT")).toBe(true);
        expect(emoji.useKey).toBe("options.licenses_use_emoji");
        const en = (await import("../i18n/en")).translations;
        const fr = (await import("../i18n/fr")).translations;
        expect(emoji.authorsKey).toBe("options.licenses_authors_emoji");
        expect(en["options.licenses_authors_emoji"]).toBe(emoji.authorsNotice);
        expect(fr["options.licenses_authors_emoji"]).not.toBe(emoji.authorsNotice);
        for (const text of [en["options.licenses_use_emoji"], fr["options.licenses_use_emoji"]]) {
            expect(text).toContain("{license}");
            expect(text).toContain("Odoo 18");
            expect(text).toContain("LGPL-3.0");
        }
    });

    it("renders the emoji entry with no base licence button", () => {
        const emoji = THIRD_PARTY_NOTICES.find((n) => n.name === "Unicode CLDR emoji data")!;
        expect(emoji.baseLicenseName).toBeUndefined();
        expect(emoji.baseLicenseText).toBeUndefined();
        const template = readFileSync("src/components/options/licenses/options_licenses_component.ts", "utf8");
        expect(template).toMatch(/<button t-if="notice\.baseLicenseName"/);
        expect(template).toMatch(/<pre t-if="notice\.baseLicenseText and state\.base"/);
        expect(template).toContain("t(notice.useKey or 'options.licenses_use'");
        expect(THIRD_PARTY_NOTICES[0].useKey).toBeUndefined();
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
