import { describe, it, expect, vi } from "vitest";

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
