import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockApi } = vi.hoisted(() => ({
    mockApi: {
        connect: vi.fn(),
        execute: vi.fn(),
        disconnect: vi.fn(),
        clearKnownHost: vi.fn(),
        addListener: vi.fn(),
    },
}));

vi.mock("@capacitor/core", () => ({
    registerPlugin: () => mockApi,
}));

import { SshPlugin } from "../plugins/sshPlugin";

describe("SshPlugin TS bridge", () => {
    beforeEach(() => {
        Object.values(mockApi).forEach((m: any) => m.mockReset?.());
    });

    it("connect with password forwards every option", async () => {
        mockApi.connect.mockResolvedValue({ hostKeyFingerprint: "sha256:abc" });
        const r = await SshPlugin.connect({
            host: "example.com", port: 22, username: "u",
            authType: "password", credential: "p",
        });
        expect(r.hostKeyFingerprint).toBe("sha256:abc");
        expect(mockApi.connect).toHaveBeenCalledWith({
            host: "example.com", port: 22, username: "u",
            authType: "password", credential: "p",
        });
    });

    it("connect with key forwards passphrase", async () => {
        mockApi.connect.mockResolvedValue({});
        await SshPlugin.connect({
            host: "h", port: 2222, username: "u",
            authType: "key", credential: "PEM-CONTENT", passphrase: "pp",
        });
        const args = mockApi.connect.mock.calls[0][0];
        expect(args.authType).toBe("key");
        expect(args.passphrase).toBe("pp");
    });

    it("execute returns the exit code", async () => {
        mockApi.execute.mockResolvedValue({ exitCode: 7 });
        const r = await SshPlugin.execute({ command: "uptime" });
        expect(r.exitCode).toBe(7);
        expect(mockApi.execute).toHaveBeenCalledWith({ command: "uptime" });
    });

    it("disconnect resolves with no value", async () => {
        mockApi.disconnect.mockResolvedValue(undefined);
        await expect(SshPlugin.disconnect()).resolves.toBeUndefined();
    });

    it("clearKnownHost forwards the host", async () => {
        mockApi.clearKnownHost.mockResolvedValue(undefined);
        await SshPlugin.clearKnownHost({ host: "a.b.c" });
        expect(mockApi.clearKnownHost).toHaveBeenCalledWith({ host: "a.b.c" });
    });

    it("addListener wires the sshOutput stream", async () => {
        mockApi.addListener.mockResolvedValue({ remove: vi.fn() });
        const fn = vi.fn();
        await SshPlugin.addListener("sshOutput", fn);
        expect(mockApi.addListener).toHaveBeenCalledWith("sshOutput", fn);
    });
});
