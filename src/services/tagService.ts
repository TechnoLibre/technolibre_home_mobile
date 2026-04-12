import { v4 as uuidv4 } from "uuid";
import { Tag } from "../models/tag";
import { DatabaseService } from "./databaseService";

export class TagService {
    private _db: DatabaseService;
    private _cache: Tag[] | null = null;

    constructor(db: DatabaseService) {
        this._db = db;
    }

    /** Load all tags from DB (updates in-memory cache). */
    async getAllTags(): Promise<Tag[]> {
        this._cache = await this._db.getAllTags();
        return this._cache;
    }

    /**
     * Return the current cache synchronously.
     * The cache is populated after the first `getAllTags()` call.
     * Components that need synchronous access must call `getAllTags()` first
     * (e.g. in onMounted).
     */
    getCached(): Tag[] {
        return this._cache ?? [];
    }

    invalidateCache(): void {
        this._cache = null;
    }

    /** Tags with no parent (top-level). */
    async getRootTags(): Promise<Tag[]> {
        const all = await this.getAllTags();
        return all.filter((t) => !t.parentId);
    }

    /** Direct children of a tag. */
    async getChildTags(parentId: string): Promise<Tag[]> {
        const all = await this.getAllTags();
        return all.filter((t) => t.parentId === parentId);
    }

    async getTagsByIds(ids: string[]): Promise<Tag[]> {
        const all = await this.getAllTags();
        return all.filter((t) => ids.includes(t.id));
    }

    async getTagById(id: string): Promise<Tag | null> {
        const all = await this.getAllTags();
        return all.find((t) => t.id === id) ?? null;
    }

    async addTag(tag: Tag): Promise<void> {
        await this._db.addTag(tag);
        this._cache = null;
    }

    async updateTag(id: string, tag: Tag): Promise<void> {
        await this._db.updateTag(id, tag);
        this._cache = null;
    }

    async deleteTag(id: string): Promise<void> {
        await this._db.deleteTag(id);
        this._cache = null;
    }

    /**
     * Recursively collect all descendant IDs (children, grandchildren, …)
     * of a given tag.
     */
    async getAllDescendantIds(tagId: string): Promise<string[]> {
        const all = await this.getAllTags();
        const result: string[] = [];
        const queue = [tagId];
        while (queue.length > 0) {
            const current = queue.shift()!;
            const children = all.filter((t) => t.parentId === current);
            for (const child of children) {
                result.push(child.id);
                queue.push(child.id);
            }
        }
        return result;
    }

    getNewId(): string {
        return uuidv4();
    }
}
