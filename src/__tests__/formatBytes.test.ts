import { describe, expect, it } from "vitest";

import { formatBytes } from "../utils/formatBytes";

const NB = " ";

describe("formatBytes", () => {
    it("names the units in French and in English", () => {
        expect(formatBytes(512, "fr")).toBe(`512${NB}o`);
        expect(formatBytes(512, "en")).toBe(`512${NB}B`);
        expect(formatBytes(17507, "fr")).toBe(`17${NB}Ko`);
        expect(formatBytes(17507, "en")).toBe(`17${NB}KB`);
        expect(formatBytes(3 * 1024 ** 3, "fr")).toBe(`3${NB}Go`);
        expect(formatBytes(3 * 1024 ** 3, "en")).toBe(`3${NB}GB`);
    });

    it("gives one decimal from 1 MB, in the language's own decimal mark", () => {
        expect(formatBytes(1385624, "fr")).toBe(`1,3${NB}Mo`);
        expect(formatBytes(1385624, "en")).toBe(`1.3${NB}MB`);
        expect(formatBytes(134217728, "fr")).toBe(`128${NB}Mo`);
        expect(formatBytes(134217728, "en")).toBe(`128${NB}MB`);
    });

    it("counts by 1024 and never shows 1024 of a unit", () => {
        expect(formatBytes(1023, "en")).toBe(`1023${NB}B`);
        expect(formatBytes(1024, "en")).toBe(`1${NB}KB`);
        expect(formatBytes(1024 * 1024 - 1, "en")).toBe(`1${NB}MB`);
        expect(formatBytes(0, "fr")).toBe(`0${NB}o`);
    });

    it("a language other than French gets the English units", () => {
        expect(formatBytes(2048, "de")).toBe(`2${NB}KB`);
    });
});
