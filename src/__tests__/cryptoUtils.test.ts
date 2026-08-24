import { describe, it, expect, beforeEach } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import {
    encryptCredential,
    decryptCredential,
    isEncrypted,
} from "../utils/cryptoUtils";

const ENCRYPTED_PREFIX = "enc:";

describe("cryptoUtils", () => {
    beforeEach(async () => {
        await SecureStoragePlugin.clear();
    });

    describe("isEncrypted", () => {
        it("returns true on the enc: prefix only", () => {
            expect(isEncrypted("enc:iv:ct")).toBe(true);
            expect(isEncrypted("plaintext")).toBe(false);
            expect(isEncrypted("")).toBe(false);
        });
    });

    describe("encryptCredential", () => {
        it("returns empty string unchanged", async () => {
            expect(await encryptCredential("")).toBe("");
        });

        it("returns already-encrypted input unchanged (no double encrypt)", async () => {
            const already = "enc:base64iv:base64ct";
            expect(await encryptCredential(already)).toBe(already);
        });

        it("returns enc:<iv>:<ciphertext> for plaintext", async () => {
            const out = await encryptCredential("hunter2");
            expect(out.startsWith(ENCRYPTED_PREFIX)).toBe(true);
            const parts = out.slice(ENCRYPTED_PREFIX.length).split(":");
            expect(parts).toHaveLength(2);
            expect(parts[0].length).toBeGreaterThan(0);
            expect(parts[1].length).toBeGreaterThan(0);
        });

        it("uses a fresh IV per call so two encryptions of the same plaintext differ", async () => {
            const a = await encryptCredential("same");
            const b = await encryptCredential("same");
            expect(a).not.toBe(b);
        });
    });

    describe("decryptCredential", () => {
        it("returns empty string unchanged", async () => {
            expect(await decryptCredential("")).toBe("");
        });

        it("returns legacy plaintext unchanged (no prefix)", async () => {
            expect(await decryptCredential("hunter2")).toBe("hunter2");
        });

        it("returns malformed enc: input unchanged (one segment)", async () => {
            expect(await decryptCredential("enc:onlyone")).toBe("enc:onlyone");
        });

        it("decrypts a value produced by encryptCredential (roundtrip)", async () => {
            const plain = "P@ssw0rd! ✓";
            const cipher = await encryptCredential(plain);
            expect(await decryptCredential(cipher)).toBe(plain);
        });

        it("roundtrips multiple values consistently", async () => {
            const samples = ["a", "longer string with spaces", "{json:1}", "🔒"];
            for (const s of samples) {
                expect(await decryptCredential(await encryptCredential(s))).toBe(s);
            }
        });
    });

    describe("key persistence", () => {
        it("reuses the existing SecureStorage key across calls", async () => {
            await encryptCredential("first");
            const keysBefore = (await SecureStoragePlugin.keys()).value;
            await encryptCredential("second");
            const keysAfter = (await SecureStoragePlugin.keys()).value;
            expect(keysAfter).toEqual(keysBefore);
        });
    });
});
