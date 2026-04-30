import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockBundle, mockEditable } = vi.hoisted(() => ({
    mockBundle: vi.fn(),
    mockEditable: vi.fn(),
}));

vi.mock("../services/bundleCodeService", () => ({
    BundleCodeService: class { constructor(...a: any[]) { return mockBundle(...a); } },
}));
vi.mock("../services/editableCodeService", () => ({
    EditableCodeService: class { constructor(slug: string) { return mockEditable(slug); } },
}));

import { getRepoFs } from "../services/repoFsFactory";

const project = {
    slug: "foo",
    name: "foo",
    archive: "repos/foo.tar.gz",
    indexUrl: "repos/foo.json",
} as any;

describe("getRepoFs", () => {
    beforeEach(() => {
        mockBundle.mockReset();
        mockEditable.mockReset();
        mockBundle.mockImplementation(() => ({
            initialize: vi.fn().mockResolvedValue(undefined),
            __kind: "bundle",
        }));
        mockEditable.mockImplementation((slug: string) => ({
            __kind: "editable",
            slug,
        }));
    });

    it("returns EditableCodeService when the slug is editable", async () => {
        const editor = { isEditable: vi.fn().mockResolvedValue(true) } as any;
        const extractor = {} as any;
        const fs = await getRepoFs(project, extractor, editor) as any;
        expect(editor.isEditable).toHaveBeenCalledWith("foo");
        expect(fs.__kind).toBe("editable");
        expect(fs.slug).toBe("foo");
        expect(mockBundle).not.toHaveBeenCalled();
    });

    it("returns initialized BundleCodeService for read-only repos", async () => {
        const editor = { isEditable: vi.fn().mockResolvedValue(false) } as any;
        const extractor = {} as any;
        const fs = await getRepoFs(project, extractor, editor) as any;
        expect(fs.__kind).toBe("bundle");
        // Constructor wired with archiveUrl/indexUrl prefixed by '/' and the slug.
        const args = mockBundle.mock.calls[0];
        expect(args[0]).toBe("/ignored");
        expect(args[1]).toEqual({
            archiveUrl: "/repos/foo.tar.gz",
            indexUrl: "/repos/foo.json",
            slug: "foo",
        });
        expect(args[2]).toBe(extractor);
    });

    it("calls initialize on the bundle before returning", async () => {
        const init = vi.fn().mockResolvedValue(undefined);
        mockBundle.mockImplementation(() => ({ initialize: init, __kind: "bundle" }));
        const editor = { isEditable: vi.fn().mockResolvedValue(false) } as any;
        await getRepoFs(project, {} as any, editor);
        expect(init).toHaveBeenCalledTimes(1);
    });
});
