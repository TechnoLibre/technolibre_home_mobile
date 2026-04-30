import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockApi } = vi.hoisted(() => ({
    mockApi: { post: vi.fn(), getCertificatePin: vi.fn() },
}));

vi.mock("@capacitor/core", () => ({
    registerPlugin: () => mockApi,
}));

import { RawHttp } from "../plugins/rawHttpPlugin";

describe("RawHttp TS bridge", () => {
    beforeEach(() => {
        mockApi.post.mockReset();
        mockApi.getCertificatePin.mockReset();
    });

    it("post forwards every field and returns the typed response", async () => {
        mockApi.post.mockResolvedValue({
            status: 200,
            headers: { "content-type": "application/json" },
            data: '{"ok":true}',
        });
        const r = await RawHttp.post({
            url: "https://10.0.0.5/jsonrpc",
            headers: { Cookie: "session=x" },
            body: '{"jsonrpc":"2.0"}',
        });
        expect(r.status).toBe(200);
        expect(r.data).toBe('{"ok":true}');
        const args = mockApi.post.mock.calls[0][0];
        expect(args.url).toBe("https://10.0.0.5/jsonrpc");
        expect(args.headers.Cookie).toBe("session=x");
        expect(args.certPin).toBeUndefined();
    });

    it("post passes the optional cert pin through", async () => {
        mockApi.post.mockResolvedValue({ status: 200, headers: {}, data: "" });
        await RawHttp.post({
            url: "u", headers: {}, body: "", certPin: "sha256/AAAA",
        });
        expect(mockApi.post.mock.calls[0][0].certPin).toBe("sha256/AAAA");
    });

    it("getCertificatePin returns the typed pin info", async () => {
        const info = {
            pin: "sha256/AAAA",
            subject: "CN=example",
            issuer: "Self-signed",
            expires: "2030-01-01",
        };
        mockApi.getCertificatePin.mockResolvedValue(info);
        const r = await RawHttp.getCertificatePin({ url: "https://h" });
        expect(r).toEqual(info);
        expect(mockApi.getCertificatePin).toHaveBeenCalledWith({ url: "https://h" });
    });

    it("propagates a TLS handshake error", async () => {
        mockApi.post.mockRejectedValue(new Error("cert pin mismatch"));
        await expect(
            RawHttp.post({ url: "u", headers: {}, body: "", certPin: "wrong" }),
        ).rejects.toThrow(/cert pin mismatch/);
    });
});
