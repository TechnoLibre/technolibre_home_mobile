import { describe, it, expect, vi, beforeEach } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";

import { addNotePriority } from "../services/migrations/addNotePriority";
import { addReminderCreatedAt } from "../services/migrations/addReminderCreatedAt";
import { addProcessesTable } from "../services/migrations/addProcessesTable";
import { addProcessDebugLogColumn }
    from "../services/migrations/addProcessDebugLogColumn";
import { addProcessResultColumn }
    from "../services/migrations/addProcessResultColumn";
import { addEditableReposTable }
    from "../services/migrations/addEditableReposTable";
import { addOdooVersionToApplications }
    from "../services/migrations/addOdooVersionToApplications";
import { addNtfyTokenColumn }
    from "../services/migrations/addNtfyTokenColumn";
import { addApplicationSyncFields }
    from "../services/migrations/addApplicationSyncFields";
import { addSyncColumns } from "../services/migrations/addSyncColumns";
import { addSyncConfigId } from "../services/migrations/addSyncConfigId";
import { addSyncPerServerStatus }
    from "../services/migrations/addSyncPerServerStatus";
import { addSelectedSyncConfigIds }
    from "../services/migrations/addSelectedSyncConfigIds";
import { addChatTables } from "../services/migrations/addChatTables";
import { addChatLot2Columns } from "../services/migrations/addChatLot2Columns";
import { addChatCreateFailed } from "../services/migrations/addChatCreateFailed";
import { addChatLeftUnsent } from "../services/migrations/addChatLeftUnsent";
import { addChatAttachments } from "../services/migrations/addChatAttachments";
import { addChatDrafts } from "../services/migrations/addChatDrafts";
import { addChatDraftOrigin } from "../services/migrations/addChatDraftOrigin";
import { addChatActions } from "../services/migrations/addChatActions";
import { addChatDraftModes } from "../services/migrations/addChatDraftModes";
import { addChatMessageSearch } from "../services/migrations/addChatMessageSearch";
import { addChatMailbox } from "../services/migrations/addChatMailbox";
import { addChatOnTop } from "../services/migrations/addChatOnTop";
import { addChatRecordThreads } from "../services/migrations/addChatRecordThreads";
import { addChatAvatars } from "../services/migrations/addChatAvatars";
import { addChatPush } from "../services/migrations/addChatPush";
import { addChatPushPrefs } from "../services/migrations/addChatPushPrefs";
import { APP_MIGRATIONS } from "../services/migrations";
import { DatabaseService } from "../services/databaseService";
import { ChatRepository } from "../services/chat/chatRepository";

// Each migration is a thin wrapper that delegates to one DatabaseService
// method and returns { counts: {} }. The contract under test is that
// (a) the right db method is called, (b) once, (c) the result shape is
// consistent. Errors in db.* should propagate (not be swallowed).

const cases: Array<{
    name: string;
    migration: (db: any) => Promise<unknown>;
    method: string;
}> = [
    { name: "addNotePriority",            migration: addNotePriority,            method: "addPriorityToNotes" },
    { name: "addReminderCreatedAt",       migration: addReminderCreatedAt,       method: "addCreatedAtToReminders" },
    { name: "addProcessesTable",          migration: addProcessesTable,          method: "createProcessesTable" },
    { name: "addProcessDebugLogColumn",   migration: addProcessDebugLogColumn,   method: "addDebugLogColumnToProcesses" },
    { name: "addProcessResultColumn",     migration: addProcessResultColumn,     method: "addResultColumnToProcesses" },
    { name: "addEditableReposTable",      migration: addEditableReposTable,      method: "createEditableReposTable" },
    { name: "addOdooVersionToApplications",
                                          migration: addOdooVersionToApplications,
                                          method: "addOdooVersionToApplications" },
    { name: "addNtfyTokenColumn",         migration: addNtfyTokenColumn,         method: "addNtfyTokenColumn" },
    { name: "addApplicationSyncFields",   migration: addApplicationSyncFields,   method: "addSyncFieldsToApplications" },
    { name: "addSyncColumns",             migration: addSyncColumns,             method: "addSyncColumnsToNotes" },
    { name: "addSyncConfigId",            migration: addSyncConfigId,            method: "addSyncConfigIdColumn" },
    { name: "addSyncPerServerStatus",     migration: addSyncPerServerStatus,     method: "addSyncPerServerStatusColumn" },
    { name: "addSelectedSyncConfigIds",   migration: addSelectedSyncConfigIds,   method: "addSelectedSyncConfigIdsColumn" },
    { name: "addChatTables",             migration: addChatTables,             method: "createChatTables" },
    { name: "addChatLot2Columns",       migration: addChatLot2Columns,       method: "addChatLot2Columns" },
    { name: "addChatCreateFailed",      migration: addChatCreateFailed,      method: "addChatLot2Columns" },
    { name: "addChatLeftUnsent",        migration: addChatLeftUnsent,        method: "addChatLeftUnsent" },
    { name: "addChatAttachments",      migration: addChatAttachments,      method: "addChatAttachments" },
    { name: "addChatDrafts",           migration: addChatDrafts,           method: "addChatDrafts" },
    { name: "addChatDraftOrigin",      migration: addChatDraftOrigin,      method: "addChatDraftOrigin" },
    { name: "addChatActions",          migration: addChatActions,          method: "addChatActions" },
    { name: "addChatDraftModes",       migration: addChatDraftModes,       method: "addChatDraftModes" },
    { name: "addChatMessageSearch",    migration: addChatMessageSearch,    method: "addChatMessageSearch" },
    { name: "addChatMailbox",          migration: addChatMailbox,          method: "addChatMailbox" },
    { name: "addChatOnTop",            migration: addChatOnTop,            method: "addChatOnTop" },
    { name: "addChatRecordThreads",    migration: addChatRecordThreads,    method: "addChatRecordThreads" },
    { name: "addChatAvatars",          migration: addChatAvatars,          method: "addChatAvatars" },
    { name: "addChatPush",             migration: addChatPush,             method: "addChatPush" },
    { name: "addChatPushPrefs",        migration: addChatPushPrefs,        method: "addChatPushPrefs" },
];

describe("schema migrations (one-method wrappers)", () => {
    for (const { name, migration, method } of cases) {
        describe(name, () => {
            it(`calls db.${method}() exactly once and returns { counts: {} }`, async () => {
                const db: any = { [method]: vi.fn().mockResolvedValue(undefined) };
                const r = await migration(db);
                expect(db[method]).toHaveBeenCalledTimes(1);
                expect(r).toEqual({ counts: {} });
            });

            it("propagates db errors instead of swallowing them", async () => {
                const db: any = {
                    [method]: vi.fn().mockRejectedValue(new Error("boom")),
                };
                await expect(migration(db)).rejects.toThrow(/boom/);
            });
        });
    }
});

describe("2026103001 push preferences", () => {
    let db: DatabaseService;
    const migration = () => APP_MIGRATIONS.find((m) => m.version === 2026103001)!;
    const colsOf = async (t: string) => (await db.rawQuery(`PRAGMA table_info(${t})`)).map((c) => c.name);
    const PUSH_PREFS = ["phone_filter", "inbox_notify", "inbox_mentions", "quiet_on", "quiet_from", "quiet_to"];
    const SOURCE_PREFS = ["channel_notifications", "channel_notifications_at"];

    beforeEach(async () => {
        SecureStoragePlugin._store.clear();
        db = new DatabaseService();
        await db.initialize();
    });

    it("2026103001 adds the push preference columns with their defaults", async () => {
        const versions = APP_MIGRATIONS.map((m) => m.version);
        expect(versions[versions.indexOf(2026103001) - 1]).toBe(2026102801);
        expect(versions[versions.length - 1]).toBe(2026103001);
        expect(migration().description).toBe("Clavardage : préférences de notification");
        // The tables as migration 2026102801 and the chat tables before it left them
        const raw = (db as any).db;
        await raw.execute(`CREATE TABLE IF NOT EXISTS chat_push (
            config_id TEXT PRIMARY KEY NOT NULL, ntfy_url TEXT, odoo_ntfy_url TEXT, prefix TEXT, topic TEXT,
            endpoint TEXT, p256dh TEXT, auth TEXT, vapid_key TEXT, registered_at TEXT,
            stale_endpoints TEXT NOT NULL DEFAULT '[]', lock_screen TEXT NOT NULL DEFAULT 'hidden_locked')`);
        await raw.execute("CREATE TABLE IF NOT EXISTS chat_sources (config_id TEXT PRIMARY KEY NOT NULL, notification_type TEXT)");
        await db.rawRun("INSERT INTO chat_push (config_id, stale_endpoints, lock_screen) VALUES (?, ?, ?)", ["c", "[]", "never"]);
        await db.rawRun("INSERT INTO chat_sources (config_id) VALUES (?)", ["c"]);
        await migration().run(db);
        expect(await colsOf("chat_push")).toEqual(expect.arrayContaining(PUSH_PREFS));
        expect(await colsOf("chat_sources")).toEqual(expect.arrayContaining(SOURCE_PREFS));
        expect(await new ChatRepository(db).pushRow("c")).toMatchObject({
            lockScreen: "never", filter: "all", inboxNotify: true, inboxMentions: false, quietOn: false, quietFrom: 1320, quietTo: 420,
        });
        expect((await db.rawQuery("SELECT channel_notifications, channel_notifications_at FROM chat_sources"))[0])
            .toEqual({ channel_notifications: null, channel_notifications_at: null });
        // A second run changes nothing
        const before = [await colsOf("chat_push"), await colsOf("chat_sources")];
        await migration().run(db);
        expect([await colsOf("chat_push"), await colsOf("chat_sources")]).toEqual(before);
    });

    it("is idempotent on a database that has them, and adds no table to one without the chat", async () => {
        await migration().run(db);
        expect(await colsOf("chat_push")).toEqual([]);
        expect(await colsOf("chat_sources")).toEqual([]);
        await db.createChatTables();
        const fresh = [await colsOf("chat_push"), await colsOf("chat_sources")];
        expect(fresh[0]).toEqual(expect.arrayContaining(PUSH_PREFS));
        expect(fresh[1]).toEqual(expect.arrayContaining(SOURCE_PREFS));
        await migration().run(db);
        expect([await colsOf("chat_push"), await colsOf("chat_sources")]).toEqual(fresh);
    });
});
