import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFs } = vi.hoisted(() => ({ mockFs: { readdir: vi.fn(), deleteFile: vi.fn() } }));

vi.mock("@capacitor/camera", () => ({ Camera: {} }));
vi.mock("@capacitor/filesystem", () => ({
    Filesystem: mockFs,
    Directory: { Data: "DATA", External: "EXTERNAL" },
}));

import {
    CAPTURE_SWEEP_MARGIN_MS, ChatCapture, sweepDeviceCaptureTemps, type ChatImages, type JpegRequest,
} from "../services/chat/chatCapture";
import { outgoingPath } from "../services/chat/chatFiles";
import { UPLOAD_SLACK_BYTES } from "../services/chat/chatTransfer";
import { memoryChatFiles } from "../testing/chatFakes";

const MEMORY_ROOT = "file:///memory/files/";
const FILE_DIR = "f7Kq2Lm9";
const LIMIT = 134217728;

const relOf = (uri: string) => decodeURI(uri.slice(MEMORY_ROOT.length));
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

/**
 * A stand-in for the native <input type=file>: attributes in a map, the
 * picker answered by choose() or dismiss() after click().
 */
class FakeInput extends EventTarget {
    attrs = new Map<string, string>();
    type = "";
    value = "x";
    multiple = false;
    files: File[] | null = null;
    clicks = 0;
    setAttribute(name: string, value: string) { this.attrs.set(name, value); }
    removeAttribute(name: string) { this.attrs.delete(name); }
    getAttribute(name: string) { return this.attrs.get(name) ?? null; }
    click() { this.clicks++; }
    choose(files: File[]) {
        this.files = files;
        this.dispatchEvent(new Event("change"));
    }
    dismiss() { this.dispatchEvent(new Event("cancel")); }
}

/**
 * memoryChatFiles whose rename refuses an existing destination, as a
 * platform that does not overwrite; failRename makes the rename onto that
 * path fail once.
 */
function strictFiles(files: ReturnType<typeof memoryChatFiles>) {
    const ops: string[] = [];
    let failRename: string | null = null;
    const strict = {
        ...files,
        ops,
        failOnce(path: string) { failRename = path; },
        async rename(from: string, to: string) {
            ops.push(`rename ${from.split("/").pop()} > ${to.split("/").pop()}`);
            if (files.bytes(to)) throw new Error(`exists: ${to}`);
            if (to === failRename) { failRename = null; throw new Error("rename failed"); }
            await files.rename(from, to);
        },
        async remove(rel: string) {
            ops.push(`remove ${rel.split("/").pop()}`);
            await files.remove(rel);
        },
    };
    return strict;
}

const asInput = (i: FakeInput) => i as unknown as HTMLInputElement;
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Fake native JPEG writer: writes `out` bytes at `to` and reports the given size. */
function fakeImages(files: ReturnType<typeof memoryChatFiles>, out = 900, size = { width: 1920, height: 1440 }) {
    const calls: JpegRequest[] = [];
    const images: ChatImages = {
        async toJpeg(req) {
            calls.push(req);
            if (!files.bytes(relOf(req.from))) throw new Error("no source");
            files.put(relOf(req.to), bytes(out, 9));
            return { size: out, ...size };
        },
    };
    return { images, calls };
}

function fakeCamera(state: string, answer = state) {
    return {
        checkPermissions: vi.fn(async () => ({ camera: state, photos: "granted" })),
        requestPermissions: vi.fn(async () => ({ camera: answer, photos: "granted" })),
    };
}

describe("ChatCapture", () => {
    let files: ReturnType<typeof memoryChatFiles>;
    let removeTemp: ReturnType<typeof vi.fn>;
    let sweep: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        files = memoryChatFiles();
        removeTemp = vi.fn(async () => {});
        sweep = vi.fn(async () => {});
    });

    function capture(over: Partial<ConstructorParameters<typeof ChatCapture>[0]> = {}) {
        return new ChatCapture({
            files,
            images: fakeImages(files).images,
            camera: fakeCamera("granted") as any,
            removeCaptureTemp: removeTemp,
            sweepCaptureTemps: sweep,
            ...over,
        });
    }

    it("a picked file is staged under the account's out dir", async () => {
        const file = new File([bytes(1000)], "report.pdf", { type: "application/pdf" });
        const staged = await capture().stage(FILE_DIR, file, { maxUploadSize: LIMIT });
        if ("refused" in staged) throw new Error("refused");
        expect(staged.path).toBe(outgoingPath(FILE_DIR, staged.localUuid, "report.pdf"));
        expect(staged.path.startsWith(`chat/${FILE_DIR}/out/${staged.localUuid}/`)).toBe(true);
        expect(staged).toMatchObject({ name: "report.pdf", mimetype: "application/pdf", size: 1000, voice: false });
        expect(files.bytes(staged.path)).toEqual(bytes(1000));
    });

    it("a file without a type gets one from its extension, else octet-stream", async () => {
        const c = capture();
        const a = await c.stage(FILE_DIR, new File([bytes(3)], "notes.txt"), { maxUploadSize: LIMIT });
        const b = await c.stage(FILE_DIR, new File([bytes(3)], "blob"), { maxUploadSize: LIMIT });
        expect(a).toMatchObject({ mimetype: "text/plain" });
        expect(b).toMatchObject({ mimetype: "application/octet-stream" });
    });

    it("gallery multi-pick keeps the order", async () => {
        const input = new FakeInput();
        const picked = capture().pickFiles(asInput(input), "gallery");
        await flush();
        expect(input.clicks).toBe(1);
        expect(input.getAttribute("accept")).toBe("image/*");
        expect(input.getAttribute("capture")).toBeNull();
        expect(input.multiple).toBe(true);
        expect(input.value).toBe("");
        const chosen = ["c.jpg", "a.jpg", "b.png"].map((n) => new File([bytes(2)], n, { type: "image/jpeg" }));
        input.choose(chosen);
        expect((await picked).map((f) => f.name)).toEqual(["c.jpg", "a.jpg", "b.png"]);
    });

    it("any file asks for several files of every type", async () => {
        const input = new FakeInput();
        input.setAttribute("accept", "image/*");
        input.setAttribute("capture", "environment");
        const picked = capture().pickFiles(asInput(input), "file");
        await flush();
        expect(input.getAttribute("accept")).toBeNull();
        expect(input.getAttribute("capture")).toBeNull();
        expect(input.multiple).toBe(true);
        input.dismiss();
        expect(await picked).toEqual([]);
    });

    it("a camera shot is named IMG_<date>.jpg and its capture copy removed once staged", async () => {
        const input = new FakeInput();
        const picked = capture().pickFiles(asInput(input), "camera");
        await flush();
        expect(input.getAttribute("accept")).toBe("image/*");
        expect(input.getAttribute("capture")).toBe("environment");
        expect(input.multiple).toBe(false);
        const shot = new Date(2026, 9, 26, 14, 5, 9).getTime();
        input.choose([new File([bytes(50)], "JPEG_20261026_140509_123456789.jpg", { type: "image/jpeg", lastModified: shot })]);
        const [file] = await picked;
        expect(file.name).toBe("IMG_20261026_140509.jpg");
        expect(removeTemp).not.toHaveBeenCalled();
        const staged = await capture().stage(FILE_DIR, file, { maxUploadSize: LIMIT });
        expect(staged).toMatchObject({ name: "IMG_20261026_140509.jpg", mimetype: "image/jpeg", size: 50 });
        expect(removeTemp).toHaveBeenCalledWith("JPEG_20261026_140509_123456789.jpg");
    });

    it("a camera shot over the limit is refused and its capture copy removed", async () => {
        const input = new FakeInput();
        const picked = capture().pickFiles(asInput(input), "camera");
        input.choose([new File([bytes(50)], "JPEG_20261026_140509_42.jpg", { type: "image/jpeg" })]);
        const [file] = await picked;
        const over = await capture().stage(FILE_DIR, file, { maxUploadSize: UPLOAD_SLACK_BYTES + 49 });
        expect(over).toEqual({ refused: "too_big", limit: UPLOAD_SLACK_BYTES + 49 });
        expect(removeTemp).toHaveBeenCalledWith("JPEG_20261026_140509_42.jpg");
    });

    it("camera permission refused gives no file", async () => {
        // The chooser asks for the permission itself and a refusal dismisses the pick
        const camera = fakeCamera("prompt", "denied");
        const input = new FakeInput();
        const picked = capture({ camera: camera as any }).pickFiles(asInput(input), "camera");
        expect(input.clicks).toBe(1);
        input.dismiss();
        expect(await picked).toEqual([]);
        expect(camera.requestPermissions).not.toHaveBeenCalled();
        expect(removeTemp).not.toHaveBeenCalled();
    });

    it("the picker opens within the tap, before any await", () => {
        const input = new FakeInput();
        void capture({ camera: fakeCamera("prompt") as any }).pickFiles(asInput(input), "camera");
        void capture().pickFiles(asInput(new FakeInput()), "gallery");
        expect(input.clicks).toBe(1);
    });

    it("ensureCameraPermission asks once and reports a refusal", async () => {
        const camera = fakeCamera("prompt", "denied");
        expect(await capture({ camera: camera as any }).ensureCameraPermission()).toBe(false);
        expect(camera.requestPermissions).toHaveBeenCalledWith({ permissions: ["camera"] });
    });

    it("camera permission already granted is not asked again", async () => {
        const camera = fakeCamera("granted");
        expect(await capture({ camera: camera as any }).ensureCameraPermission()).toBe(true);
        expect(camera.requestPermissions).not.toHaveBeenCalled();
    });

    it("HEIC becomes JPEG with a .jpg name", async () => {
        const { images, calls } = fakeImages(files, 2500);
        const file = new File([bytes(1200)], "beach.HEIC", { type: "image/heic" });
        const staged = await capture({ images }).stage(FILE_DIR, file, { maxUploadSize: LIMIT });
        if ("refused" in staged) throw new Error("refused");
        expect(staged).toMatchObject({ name: "beach.jpg", mimetype: "image/jpeg", size: 2500 });
        expect(staged.path).toBe(outgoingPath(FILE_DIR, staged.localUuid, "beach.jpg"));
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ maxPx: 0, quality: 92 });
        expect(relOf(calls[0].to)).toBe(staged.path);
        expect(await files.list(`chat/${FILE_DIR}/out/${staged.localUuid}`)).toEqual(["beach.jpg"]);
    });

    it("a HEIC the phone cannot decode is sent as is", async () => {
        const images: ChatImages = { toJpeg: async () => { throw new Error("undecodable"); } };
        const file = new File([bytes(1200)], "beach.heif", { type: "" });
        const staged = await capture({ images }).stage(FILE_DIR, file, { maxUploadSize: LIMIT });
        expect(staged).toMatchObject({ name: "beach.heif", mimetype: "image/heif", size: 1200 });
    });

    it("a file over the limit is refused before any write", async () => {
        const limit = 1000 + UPLOAD_SLACK_BYTES;
        const c = capture();
        const fits = await c.stage(FILE_DIR, new File([bytes(1000)], "a.bin"), { maxUploadSize: limit });
        expect("refused" in fits).toBe(false);
        const before = await files.list(`chat/${FILE_DIR}/out`);
        const write = vi.spyOn(files, "writeBlob");
        const over = await c.stage(FILE_DIR, new File([bytes(1001)], "b.bin"), { maxUploadSize: limit });
        expect(over).toEqual({ refused: "too_big", limit });
        expect(write).not.toHaveBeenCalled();
        expect(await files.list(`chat/${FILE_DIR}/out`)).toEqual(before);
    });

    it("a HEIC whose JPEG passes the limit is refused and leaves nothing", async () => {
        const limit = 2000 + UPLOAD_SLACK_BYTES;
        const { images } = fakeImages(files, 2001);
        const over = await capture({ images }).stage(FILE_DIR, new File([bytes(1500)], "x.heic"), { maxUploadSize: limit });
        expect(over).toEqual({ refused: "too_big", limit });
        expect(await files.list(`chat/${FILE_DIR}/out`)).toEqual([]);
    });

    it("compress fits 1920 px at quality 80", async () => {
        const { images, calls } = fakeImages(files, 400);
        const c = capture({ images });
        const staged = await c.stage(FILE_DIR, new File([bytes(5000)], "IMG_1.png", { type: "image/png" }), { maxUploadSize: LIMIT });
        if ("refused" in staged) throw new Error("refused");
        const small = await c.compress(staged);
        expect(calls.at(-1)).toMatchObject({ maxPx: 1920, quality: 80 });
        expect(relOf(calls.at(-1)!.from)).toBe(staged.path);
        expect(small).toMatchObject({ localUuid: staged.localUuid, name: "IMG_1.jpg", mimetype: "image/jpeg", size: 400 });
        expect(small.path).toBe(outgoingPath(FILE_DIR, staged.localUuid, "IMG_1.jpg"));
        expect(files.bytes(small.path)).toEqual(bytes(400, 9));
        expect(await files.list(`chat/${FILE_DIR}/out/${staged.localUuid}`)).toEqual(["IMG_1.jpg"]);
    });

    it("compress keeps a JPEG it cannot make smaller", async () => {
        const { images } = fakeImages(files, 6000);
        const c = capture({ images });
        const staged = await c.stage(FILE_DIR, new File([bytes(5000)], "IMG_2.jpg", { type: "image/jpeg" }), { maxUploadSize: LIMIT });
        if ("refused" in staged) throw new Error("refused");
        expect(await c.compress(staged)).toEqual(staged);
        expect(files.bytes(staged.path)).toEqual(bytes(5000));
        expect(await files.list(`chat/${FILE_DIR}/out/${staged.localUuid}`)).toEqual(["IMG_2.jpg"]);
    });

    it("compress leaves other files and failed conversions untouched", async () => {
        const { images, calls } = fakeImages(files);
        const c = capture({ images });
        const pdf = await c.stage(FILE_DIR, new File([bytes(10)], "a.pdf", { type: "application/pdf" }), { maxUploadSize: LIMIT });
        const gif = await c.stage(FILE_DIR, new File([bytes(10)], "a.gif", { type: "image/gif" }), { maxUploadSize: LIMIT });
        if ("refused" in pdf || "refused" in gif) throw new Error("refused");
        expect(await c.compress(pdf)).toEqual(pdf);
        expect(await c.compress(gif)).toEqual(gif);
        expect(calls).toHaveLength(0);
        const failing = capture({ images: { toJpeg: async () => { throw new Error("oom"); } } });
        const jpg = await failing.stage(FILE_DIR, new File([bytes(10)], "b.jpg", { type: "image/jpeg" }), { maxUploadSize: LIMIT });
        if ("refused" in jpg) throw new Error("refused");
        expect(await failing.compress(jpg)).toEqual(jpg);
        expect(await files.list(`chat/${FILE_DIR}/out/${jpg.localUuid}`)).toEqual(["b.jpg"]);
    });

    it("a HEIC already named .jpg keeps its converted file", async () => {
        const { images } = fakeImages(files, 2500);
        const file = new File([bytes(1200)], "IMG_3.jpg", { type: "image/heic" });
        const staged = await capture({ images }).stage(FILE_DIR, file, { maxUploadSize: LIMIT });
        if ("refused" in staged) throw new Error("refused");
        expect(staged).toMatchObject({ name: "IMG_3.jpg", mimetype: "image/jpeg", size: 2500 });
        expect(files.bytes(staged.path)).toEqual(bytes(2500, 9));
    });

    it("compress of a JPEG keeps its name and never relies on an overwrite", async () => {
        const strict = strictFiles(files);
        const { images } = fakeImages(files, 400);
        const c = capture({ files: strict, images });
        const staged = await c.stage(FILE_DIR, new File([bytes(5000)], "IMG_4.jpg", { type: "image/jpeg" }), { maxUploadSize: LIMIT });
        if ("refused" in staged) throw new Error("refused");
        const small = await c.compress(staged);
        expect(small).toEqual({ ...staged, size: 400 });
        expect(files.bytes(staged.path)).toEqual(bytes(400, 9));
        expect(await files.list(`chat/${FILE_DIR}/out/${staged.localUuid}`)).toEqual(["IMG_4.jpg"]);
    });

    it("compress keeps the original when its replacement cannot take its place", async () => {
        const strict = strictFiles(files);
        const { images } = fakeImages(files, 400);
        const c = capture({ files: strict, images });
        const jpg = await c.stage(FILE_DIR, new File([bytes(5000)], "IMG_5.jpg", { type: "image/jpeg" }), { maxUploadSize: LIMIT });
        const png = await c.stage(FILE_DIR, new File([bytes(5000)], "IMG_6.png", { type: "image/png" }), { maxUploadSize: LIMIT });
        if ("refused" in jpg || "refused" in png) throw new Error("refused");
        strict.failOnce(jpg.path);
        expect(await c.compress(jpg)).toEqual(jpg);
        expect(files.bytes(jpg.path)).toEqual(bytes(5000));
        expect(await files.list(`chat/${FILE_DIR}/out/${jpg.localUuid}`)).toEqual(["IMG_5.jpg"]);
        strict.failOnce(outgoingPath(FILE_DIR, png.localUuid, "IMG_6.jpg"));
        expect(await c.compress(png)).toEqual(png);
        expect(files.bytes(png.path)).toEqual(bytes(5000));
        expect(await files.list(`chat/${FILE_DIR}/out/${png.localUuid}`)).toEqual(["IMG_6.png"]);
    });

    it("compress removes a PNG only once its JPEG is in place", async () => {
        const strict = strictFiles(files);
        const { images } = fakeImages(files, 9000);
        const c = capture({ files: strict, images });
        const png = await c.stage(FILE_DIR, new File([bytes(5000)], "IMG_7.png", { type: "image/png" }), { maxUploadSize: LIMIT });
        if ("refused" in png) throw new Error("refused");
        strict.ops.length = 0;
        // A PNG becomes a JPEG even when larger: transparency is laid on white either way
        expect(await c.compress(png)).toMatchObject({ name: "IMG_7.jpg", mimetype: "image/jpeg", size: 9000 });
        expect(strict.ops).toEqual(["rename .compress.jpg > IMG_7.jpg", "remove IMG_7.png"]);
    });

    it("a camera pick sweeps the chooser's empty leftovers after the click", async () => {
        const input = new FakeInput();
        const before = Date.now();
        const picked = capture().pickFiles(asInput(input), "camera");
        expect(input.clicks).toBe(1);
        expect(sweep).toHaveBeenCalledTimes(1);
        expect(sweep.mock.calls[0][0]).toBeLessThanOrEqual(before - CAPTURE_SWEEP_MARGIN_MS + 50);
        input.dismiss();
        await picked;
        void capture().pickFiles(asInput(new FakeInput()), "gallery");
        void capture().pickFiles(asInput(new FakeInput()), "file");
        expect(sweep).toHaveBeenCalledTimes(1);
    });
});

describe("sweepDeviceCaptureTemps", () => {
    it("deletes only the chooser's empty files older than the bound", async () => {
        mockFs.readdir.mockResolvedValue({
            files: [
                { name: "JPEG_20261026_140509_1.jpg", type: "file", size: 0, mtime: 1000, uri: "" },
                { name: "JPEG_20261026_140510_2.jpg", type: "file", size: 0, mtime: 5000, uri: "" },
                { name: "JPEG_20261026_140511_3.jpg", type: "file", size: 812, mtime: 1000, uri: "" },
                { name: "note.jpg", type: "file", size: 0, mtime: 1000, uri: "" },
            ],
        });
        mockFs.deleteFile.mockResolvedValue(undefined);
        await sweepDeviceCaptureTemps(4000);
        expect(mockFs.readdir).toHaveBeenCalledWith({ path: "Pictures", directory: "EXTERNAL" });
        expect(mockFs.deleteFile.mock.calls).toEqual([[{ path: "Pictures/JPEG_20261026_140509_1.jpg", directory: "EXTERNAL" }]]);
    });

    it("a missing Pictures directory is not an error", async () => {
        mockFs.readdir.mockRejectedValue(new Error("Directory does not exist"));
        await expect(sweepDeviceCaptureTemps(4000)).resolves.toBeUndefined();
    });
});
