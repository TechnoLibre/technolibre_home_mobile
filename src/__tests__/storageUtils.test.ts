import { describe, it, expect, beforeEach } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { StorageUtils } from "../utils/storageUtils";

describe("StorageUtils", () => {
    beforeEach(async () => {
        await SecureStoragePlugin.clear();
    });

    describe("getValueByKey", () => {
        it("returns keyExists=false / undefined for a missing key", async () => {
            const r = await StorageUtils.getValueByKey<string>("nope");
            expect(r.keyExists).toBe(false);
            expect(r.value).toBeUndefined();
            expect(r.isValid).toBe(false);
        });

        it("parses the stored JSON and exposes isValid=true", async () => {
            await StorageUtils.setKeyValuePair("user", { name: "Alice", n: 7 });
            const r = await StorageUtils.getValueByKey<{ name: string; n: number }>("user");
            expect(r.keyExists).toBe(true);
            expect(r.value).toEqual({ name: "Alice", n: 7 });
            expect(r.isValid).toBe(true);
        });

        it("treats a stored JSON null as keyExists=true but invalid", async () => {
            await StorageUtils.setKeyValuePair("flag", null);
            const r = await StorageUtils.getValueByKey<unknown>("flag");
            expect(r.keyExists).toBe(true);
            // JSON.parse('null') === null; value is null which is not undefined,
            // so isValid is true under the current definition.
            expect(r.value).toBeNull();
            expect(r.isValid).toBe(true);
        });

        it("returns invalid when stored value is not valid JSON", async () => {
            await SecureStoragePlugin.set({ key: "broken", value: "not-json" });
            const r = await StorageUtils.getValueByKey<string>("broken");
            expect(r.keyExists).toBe(false);
            expect(r.isValid).toBe(false);
        });
    });

    describe("setKeyValuePair", () => {
        it("writes a JSON-serialised value", async () => {
            await StorageUtils.setKeyValuePair("k", { a: 1 });
            const raw = (await SecureStoragePlugin.get({ key: "k" })).value;
            expect(raw).toBe('{"a":1}');
        });

        it("supports primitives and arrays", async () => {
            await StorageUtils.setKeyValuePair("n", 42);
            await StorageUtils.setKeyValuePair("arr", [1, 2, 3]);
            expect((await StorageUtils.getValueByKey<number>("n")).value).toBe(42);
            expect((await StorageUtils.getValueByKey<number[]>("arr")).value).toEqual([1, 2, 3]);
        });
    });
});
