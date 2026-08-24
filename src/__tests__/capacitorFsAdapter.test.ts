import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFs } = vi.hoisted(() => ({
    mockFs: {
        readFile: vi.fn(), writeFile: vi.fn(), deleteFile: vi.fn(),
        readdir: vi.fn(), mkdir: vi.fn(), rmdir: vi.fn(), stat: vi.fn(),
    },
}));

vi.mock("@capacitor/filesystem", () => ({
    Filesystem: mockFs,
    Directory: { Cache: "CACHE", Data: "DATA" },
}));

import { capacitorFsAdapter } from "../services/git/capacitorFsAdapter";

describe("capacitorFsAdapter", () => {
    beforeEach(() => Object.values(mockFs).forEach((f) => f.mockReset()));

    it("writeFile encodes string to base64 against Directory.Data", async () => {
        mockFs.writeFile.mockResolvedValue(undefined);
        await capacitorFsAdapter.promises.writeFile("/x.txt", "hi");
        const arg = mockFs.writeFile.mock.calls[0][0];
        expect(arg.path).toBe("x.txt");
        expect(arg.directory).toBe("DATA");
        expect(arg.data).toBe("aGk=");
    });

    it("readFile returns Uint8Array by default", async () => {
        mockFs.readFile.mockResolvedValue({ data: "aGk=" });
        const r = await capacitorFsAdapter.promises.readFile("/x.txt");
        expect(r).toBeInstanceOf(Uint8Array);
        expect(new TextDecoder().decode(r as Uint8Array)).toBe("hi");
    });

    it("readFile returns string with utf8 encoding", async () => {
        mockFs.readFile.mockResolvedValue({ data: "aGk=" });
        const r = await capacitorFsAdapter.promises.readFile("/x.txt", { encoding: "utf8" });
        expect(r).toBe("hi");
    });

    it("readdir flattens to file names", async () => {
        mockFs.readdir.mockResolvedValue({ files: [{ name: "a" }, { name: "b" }] });
        expect(await capacitorFsAdapter.promises.readdir("/d")).toEqual(["a", "b"]);
    });

    it("stat returns FsStat with right boolean methods", async () => {
        mockFs.stat.mockResolvedValue({ type: "file", size: 12, mtime: 1234567 });
        const s = await capacitorFsAdapter.promises.stat("/f");
        expect(s.isFile()).toBe(true);
        expect(s.isDirectory()).toBe(false);
        expect(s.size).toBe(12);
    });

    it("readlink throws ENOSYS", async () => {
        await expect(capacitorFsAdapter.promises.readlink("/x")).rejects.toMatchObject({ code: "ENOSYS" });
    });
});
