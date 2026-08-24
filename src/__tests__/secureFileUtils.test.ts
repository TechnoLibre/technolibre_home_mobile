import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFs } = vi.hoisted(() => ({
    mockFs: {
        writeFile: vi.fn(),
        readFile: vi.fn(),
    },
}));

vi.mock("@capacitor/filesystem", () => ({
    Filesystem: mockFs,
    Directory: { Data: "DATA", Cache: "CACHE", External: "EXTERNAL" },
    Encoding: { UTF8: "utf8" },
}));

const { mockEncrypt, mockDecrypt } = vi.hoisted(() => ({
    mockEncrypt: vi.fn(),
    mockDecrypt: vi.fn(),
}));

vi.mock("../utils/cryptoUtils", () => ({
    encryptCredential: mockEncrypt,
    decryptCredential: mockDecrypt,
}));

import {
    writeEncryptedFile,
    readEncryptedFile,
} from "../utils/secureFileUtils";

describe("secureFileUtils", () => {
    beforeEach(() => {
        Object.values(mockFs).forEach((m: any) => m.mockReset?.());
        mockEncrypt.mockReset();
        mockDecrypt.mockReset();
    });

    describe("writeEncryptedFile", () => {
        it("appends .enc and writes the encrypted payload", async () => {
            mockEncrypt.mockResolvedValue("enc:iv:ct");
            mockFs.writeFile.mockResolvedValue({ uri: "file:///d/foo.bin.enc" });
            const uri = await writeEncryptedFile("foo.bin", "AAAA");
            expect(uri).toBe("file:///d/foo.bin.enc");
            expect(mockEncrypt).toHaveBeenCalledWith("AAAA");
            expect(mockFs.writeFile).toHaveBeenCalledWith({
                path: "foo.bin.enc",
                data: "enc:iv:ct",
                directory: "DATA",
                encoding: "utf8",
            });
        });

        it("honours an alternate directory", async () => {
            mockEncrypt.mockResolvedValue("enc:x:y");
            mockFs.writeFile.mockResolvedValue({ uri: "" });
            await writeEncryptedFile("a", "b", "CACHE" as any);
            expect(mockFs.writeFile.mock.calls[0][0].directory).toBe("CACHE");
        });
    });

    describe("readEncryptedFile", () => {
        it("decrypts paths that already end in .enc", async () => {
            mockFs.readFile.mockResolvedValue({ data: "enc:iv:ct" });
            mockDecrypt.mockResolvedValue("plaintext-base64");
            const r = await readEncryptedFile("foo.bin.enc");
            expect(r).toBe("plaintext-base64");
            expect(mockFs.readFile).toHaveBeenCalledWith({
                path: "foo.bin.enc", directory: "DATA", encoding: "utf8",
            });
        });

        it("returns string data verbatim for legacy plaintext files", async () => {
            mockFs.readFile.mockResolvedValue({ data: "BBBB" });
            const r = await readEncryptedFile("legacy.bin");
            expect(r).toBe("BBBB");
            // No encoding requested for legacy reads.
            expect(mockFs.readFile).toHaveBeenCalledWith({
                path: "legacy.bin", directory: "DATA",
            });
            expect(mockDecrypt).not.toHaveBeenCalled();
        });
    });
});
