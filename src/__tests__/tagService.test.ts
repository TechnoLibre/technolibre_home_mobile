import { describe, it, expect, beforeEach } from "vitest";
import { TagService } from "../services/tagService";
import { DatabaseService } from "../services/databaseService";
import { Tag } from "../models/tag";

// ── Helpers ──────────────────────────────────────────────────────────────────

const makeTag = (overrides: Partial<Tag> = {}): Tag => ({
    id:    "tag-root-1",
    name:  "Work",
    color: "#6b7280",
    ...overrides,
});

// ── Suite ────────────────────────────────────────────────────────────────────

describe("TagService", () => {
    let db:      DatabaseService;
    let service: TagService;

    beforeEach(async () => {
        db      = new DatabaseService();
        await db.initialize();
        service = new TagService(db);
    });

    // ── Basic CRUD ────────────────────────────────────────────────────────────

    describe("getAllTags", () => {
        it("returns an empty list when no tags exist", async () => {
            expect(await service.getAllTags()).toEqual([]);
        });

        it("returns the added tag", async () => {
            const tag = makeTag({ id: "t1", name: "Personal" });
            await service.addTag(tag);
            const all = await service.getAllTags();
            expect(all).toHaveLength(1);
            expect(all[0]).toMatchObject({ id: "t1", name: "Personal" });
        });

        it("returns all tags when several exist", async () => {
            await service.addTag(makeTag({ id: "a", name: "Alpha" }));
            await service.addTag(makeTag({ id: "b", name: "Beta" }));
            await service.addTag(makeTag({ id: "c", name: "Gamma" }));
            expect(await service.getAllTags()).toHaveLength(3);
        });
    });

    describe("addTag / deleteTag", () => {
        it("adds then deletes a tag", async () => {
            await service.addTag(makeTag({ id: "del-1" }));
            expect(await service.getAllTags()).toHaveLength(1);
            await service.deleteTag("del-1");
            expect(await service.getAllTags()).toHaveLength(0);
        });

        it("invalidates the cache on add", async () => {
            await service.getAllTags();                        // populate cache
            await service.addTag(makeTag({ id: "new-1" }));  // should clear cache
            const fresh = await service.getAllTags();
            expect(fresh.some(t => t.id === "new-1")).toBe(true);
        });

        it("invalidates the cache on delete", async () => {
            await service.addTag(makeTag({ id: "rm-1" }));
            await service.getAllTags();                       // populate cache
            await service.deleteTag("rm-1");                 // clear cache
            expect(await service.getAllTags()).toHaveLength(0);
        });
    });

    describe("updateTag", () => {
        it("persists the updated name and color", async () => {
            await service.addTag(makeTag({ id: "u1", name: "Old" }));
            await service.updateTag("u1", makeTag({ id: "u1", name: "New", color: "#ff0000" }));
            const found = await service.getTagById("u1");
            expect(found?.name).toBe("New");
            expect(found?.color).toBe("#ff0000");
        });

        it("invalidates the cache on update", async () => {
            await service.addTag(makeTag({ id: "u2", name: "Before" }));
            await service.getAllTags();                       // populate cache
            await service.updateTag("u2", makeTag({ id: "u2", name: "After" }));
            const fresh = await service.getTagById("u2");
            expect(fresh?.name).toBe("After");
        });
    });

    // ── Cache ────────────────────────────────────────────────────────────────

    describe("getCached", () => {
        it("returns empty array before first getAllTags()", () => {
            expect(service.getCached()).toEqual([]);
        });

        it("returns the last-loaded tags after getAllTags()", async () => {
            await service.addTag(makeTag({ id: "c1" }));
            await service.getAllTags();
            expect(service.getCached()).toHaveLength(1);
        });
    });

    describe("invalidateCache", () => {
        it("resets getCached to empty", async () => {
            await service.addTag(makeTag({ id: "inv-1" }));
            await service.getAllTags();
            service.invalidateCache();
            expect(service.getCached()).toEqual([]);
        });

        it("forces a fresh DB read on next getAllTags()", async () => {
            await service.addTag(makeTag({ id: "inv-2" }));
            await service.getAllTags();
            service.invalidateCache();
            const fresh = await service.getAllTags();
            expect(fresh).toHaveLength(1);
        });
    });

    // ── Filtering helpers ─────────────────────────────────────────────────────

    describe("getRootTags", () => {
        it("returns only tags with no parentId", async () => {
            await service.addTag(makeTag({ id: "root-1" }));
            await service.addTag(makeTag({ id: "child-1", parentId: "root-1" }));
            const roots = await service.getRootTags();
            expect(roots).toHaveLength(1);
            expect(roots[0].id).toBe("root-1");
        });

        it("returns all tags when none have a parent", async () => {
            await service.addTag(makeTag({ id: "r1" }));
            await service.addTag(makeTag({ id: "r2" }));
            expect(await service.getRootTags()).toHaveLength(2);
        });

        it("returns an empty array when all tags are children", async () => {
            await service.addTag(makeTag({ id: "p1" }));
            await service.addTag(makeTag({ id: "p2", parentId: "p1" }));
            await service.deleteTag("p1");               // remove root, leave orphan
            const roots = await service.getRootTags();
            // orphan has parentId set, so it's not a root
            expect(roots).toHaveLength(0);
        });
    });

    describe("getChildTags", () => {
        it("returns direct children of a tag", async () => {
            await service.addTag(makeTag({ id: "par", name: "Parent" }));
            await service.addTag(makeTag({ id: "ch1", name: "Child 1", parentId: "par" }));
            await service.addTag(makeTag({ id: "ch2", name: "Child 2", parentId: "par" }));
            await service.addTag(makeTag({ id: "other" }));
            const children = await service.getChildTags("par");
            expect(children).toHaveLength(2);
            expect(children.map(c => c.id)).toEqual(expect.arrayContaining(["ch1", "ch2"]));
        });

        it("returns empty when tag has no children", async () => {
            await service.addTag(makeTag({ id: "leaf" }));
            expect(await service.getChildTags("leaf")).toHaveLength(0);
        });
    });

    describe("getTagsByIds", () => {
        it("returns only the requested tags", async () => {
            await service.addTag(makeTag({ id: "x1" }));
            await service.addTag(makeTag({ id: "x2" }));
            await service.addTag(makeTag({ id: "x3" }));
            const result = await service.getTagsByIds(["x1", "x3"]);
            expect(result).toHaveLength(2);
            expect(result.map(t => t.id)).toEqual(expect.arrayContaining(["x1", "x3"]));
        });

        it("returns empty for an empty ids list", async () => {
            await service.addTag(makeTag({ id: "y1" }));
            expect(await service.getTagsByIds([])).toHaveLength(0);
        });

        it("returns empty for ids that don't exist", async () => {
            expect(await service.getTagsByIds(["nonexistent"])).toHaveLength(0);
        });
    });

    describe("getTagById", () => {
        it("returns the matching tag", async () => {
            await service.addTag(makeTag({ id: "find-me", name: "Findable" }));
            const found = await service.getTagById("find-me");
            expect(found).not.toBeNull();
            expect(found?.name).toBe("Findable");
        });

        it("returns null for an unknown id", async () => {
            expect(await service.getTagById("does-not-exist")).toBeNull();
        });
    });

    // ── Hierarchical traversal ────────────────────────────────────────────────

    describe("getAllDescendantIds", () => {
        it("returns empty for a leaf node", async () => {
            await service.addTag(makeTag({ id: "leaf-x" }));
            expect(await service.getAllDescendantIds("leaf-x")).toEqual([]);
        });

        it("returns direct children", async () => {
            await service.addTag(makeTag({ id: "gp" }));
            await service.addTag(makeTag({ id: "ch-a", parentId: "gp" }));
            await service.addTag(makeTag({ id: "ch-b", parentId: "gp" }));
            const desc = await service.getAllDescendantIds("gp");
            expect(desc).toHaveLength(2);
            expect(desc).toEqual(expect.arrayContaining(["ch-a", "ch-b"]));
        });

        it("traverses multiple levels recursively", async () => {
            // root → child → grandchild → great-grandchild
            await service.addTag(makeTag({ id: "root" }));
            await service.addTag(makeTag({ id: "lvl1", parentId: "root" }));
            await service.addTag(makeTag({ id: "lvl2", parentId: "lvl1" }));
            await service.addTag(makeTag({ id: "lvl3", parentId: "lvl2" }));
            const desc = await service.getAllDescendantIds("root");
            expect(desc).toHaveLength(3);
            expect(desc).toEqual(expect.arrayContaining(["lvl1", "lvl2", "lvl3"]));
        });

        it("does not include tags from unrelated branches", async () => {
            await service.addTag(makeTag({ id: "branch-a" }));
            await service.addTag(makeTag({ id: "branch-b" }));
            await service.addTag(makeTag({ id: "child-of-a", parentId: "branch-a" }));
            await service.addTag(makeTag({ id: "child-of-b", parentId: "branch-b" }));
            const desc = await service.getAllDescendantIds("branch-a");
            expect(desc).toEqual(["child-of-a"]);
        });
    });

    // ── getNewId ──────────────────────────────────────────────────────────────

    describe("getNewId", () => {
        it("returns a non-empty string", () => {
            expect(typeof service.getNewId()).toBe("string");
            expect(service.getNewId().length).toBeGreaterThan(0);
        });

        it("returns a unique value on each call", () => {
            const ids = new Set([service.getNewId(), service.getNewId(), service.getNewId()]);
            expect(ids.size).toBe(3);
        });

        it("returns a value matching UUID v4 format", () => {
            const uuidV4Regex =
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
            expect(service.getNewId()).toMatch(uuidV4Regex);
        });
    });
});
