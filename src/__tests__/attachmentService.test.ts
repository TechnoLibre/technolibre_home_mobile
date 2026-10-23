import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  attachmentSettings, DEFAULT_ATTACHMENTS, fileVerdict, mediaFiles, setAttachmentSettings,
} from "../services/attachmentService";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => { items.set(k, String(v)); },
    removeItem: (k: string) => { items.delete(k); },
  };
}

const io = (over: Partial<{ size: number | null; wifi: boolean }> = {}) => ({
  size: async () => (over.size === undefined ? 1000 : over.size),
  read: async () => "QUJD",
  onWifi: async () => over.wifi ?? true,
});

describe("attachment settings and files", () => {
  beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));

  it("keeps the settings, an unreadable or zero size meaning no limit", () => {
    expect(attachmentSettings()).toEqual(DEFAULT_ATTACHMENTS);
    setAttachmentSettings({ wifiOnly: true, maxMb: 5 });
    expect(attachmentSettings()).toEqual({ wifiOnly: true, maxMb: 5 });
    localStorage.setItem("options.sync.attachments", JSON.stringify({ wifiOnly: true, maxMb: 0 }));
    expect(attachmentSettings().maxMb).toBeNull();
  });

  it("lists the note's media with a file, named and typed by extension", () => {
    const files = mediaFiles({
      id: "n", title: "", done: false, archived: false, pinned: false, tags: [],
      entries: [
        { id: "p", type: "photo", params: { path: "file:///data/IMG_1.jpg" } },
        { id: "a", type: "audio", params: { path: "file:///data/rec%201.m4a" } },
        { id: "v", type: "video", params: { path: "" } },
        { id: "t", type: "text", params: { text: "x" } },
      ],
    } as any);
    expect(files).toEqual([
      { entryId: "p", path: "file:///data/IMG_1.jpg", name: "IMG_1.jpg", mimetype: "image/jpeg" },
      { entryId: "a", path: "file:///data/rec%201.m4a", name: "rec 1.m4a", mimetype: "audio/mp4" },
    ]);
  });

  it("sends, holds for Wi-Fi or a missing file, and leaves out a file over the limit", async () => {
    const file = { entryId: "p", path: "x", name: "x.jpg", mimetype: "image/jpeg" };
    expect((await fileVerdict(file, { wifiOnly: false, maxMb: null }, io())).verdict).toBe("send");
    expect((await fileVerdict(file, { wifiOnly: true, maxMb: null }, io({ wifi: false }))).verdict).toBe("wait");
    expect((await fileVerdict(file, { wifiOnly: false, maxMb: null }, io({ size: null }))).verdict).toBe("wait");
    expect(await fileVerdict(file, { wifiOnly: false, maxMb: 1 }, io({ size: 2 * 1024 * 1024 }))).toEqual({ verdict: "too_big", size: 2097152 });
  });
});
