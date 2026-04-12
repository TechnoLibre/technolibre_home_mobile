import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProcessService } from "../services/processService";
import { DatabaseService } from "../services/databaseService";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";

describe("ProcessService", () => {
    let db: DatabaseService;
    let service: ProcessService;

    beforeEach(async () => {
        vi.clearAllMocks();
        SecureStoragePlugin._store.clear();
        db = new DatabaseService();
        await db.initialize();
        // Create the processes table (normally done by MigrationService)
        await db.createProcessesTable();
        service = new ProcessService(db);
        await service.initialize();
    });

    // ── initialize ────────────────────────────────────────────────────────────

    describe("initialize", () => {
        it("loads an empty history when the table is empty", async () => {
            expect(service.getAll()).toEqual([]);
        });

        it("loads persisted records that survived a restart", async () => {
            // Arrange: add and complete a record using the first service instance.
            // The DB connection (db) is shared — we create a second ProcessService
            // on the same db to simulate re-initialization on the same database.
            const id = service.addTranscription("audio.m4a", "note-42");
            // Wait for the fire-and-forget insertProcess to complete
            await new Promise(r => setTimeout(r, 0));
            await service.completeProcess(id, undefined, "Bonjour monde");

            // Act: new service on the same db simulates an app restart
            const svc2 = new ProcessService(db);
            await svc2.initialize();

            // Assert
            const all = svc2.getAll();
            expect(all).toHaveLength(1);
            expect(all[0].status).toBe("done");
            expect(all[0].result).toBe("Bonjour monde");
        });

        it("calls db.markInterruptedProcesses() during initialize", async () => {
            // The SQLite mock cannot process the mixed literal/placeholder UPDATE used by
            // markInterruptedProcesses, so we verify the DB method is invoked rather than
            // inspecting the stored rows (that behaviour is covered in databaseService.test.ts).
            const spy = vi.spyOn(db, "markInterruptedProcesses");
            const svc2 = new ProcessService(db);
            await svc2.initialize();
            expect(spy).toHaveBeenCalledTimes(1);
        });

        it("leaves already-completed records unchanged on initialize", async () => {
            const db2 = new DatabaseService();
            await db2.initialize();
            await db2.createProcessesTable();
            await db2.insertProcess({
                id: "done-proc",
                type: "download",
                status: "done",
                label: "ggml-tiny.bin",
                startedAt: new Date(Date.now() - 5000),
                completedAt: new Date(),
                errorMessage: null,
            });

            const svc2 = new ProcessService(db2);
            await svc2.initialize();

            const all = svc2.getAll();
            expect(all[0].status).toBe("done");
        });
    });

    // ── getAll ────────────────────────────────────────────────────────────────

    describe("getAll", () => {
        it("returns an empty array when no records exist", () => {
            expect(service.getAll()).toEqual([]);
        });

        it("returns records newest-first (most recently added at index 0)", async () => {
            service.addTranscription("first.m4a");
            service.addTranscription("second.m4a");
            service.addTranscription("third.m4a");

            const all = service.getAll();
            expect(all[0].label).toBe("third.m4a");
            expect(all[1].label).toBe("second.m4a");
            expect(all[2].label).toBe("first.m4a");
        });

        it("returns a copy — mutating the result does not affect internal state", () => {
            service.addTranscription("audio.m4a");
            const first = service.getAll();
            first.splice(0, 1);
            expect(service.getAll()).toHaveLength(1);
        });
    });

    // ── subscribe / notify ────────────────────────────────────────────────────

    describe("subscribe / notify", () => {
        it("fires the callback when a transcription is added", () => {
            const cb = vi.fn();
            service.subscribe(cb);
            service.addTranscription("audio.m4a");
            expect(cb).toHaveBeenCalledTimes(1);
        });

        it("fires the callback when completeProcess is called", async () => {
            const id = service.addTranscription("audio.m4a");
            const cb = vi.fn();
            service.subscribe(cb);
            await service.completeProcess(id);
            expect(cb).toHaveBeenCalledTimes(1);
        });

        it("fires the callback when clearAll is called", async () => {
            service.addTranscription("audio.m4a");
            const cb = vi.fn();
            service.subscribe(cb);
            await service.clearAll();
            expect(cb).toHaveBeenCalledTimes(1);
        });

        it("fires the callback when appendDebugLog is called", () => {
            const id = service.addTranscription("audio.m4a");
            const cb = vi.fn();
            service.subscribe(cb);
            service.appendDebugLog(id, "step 1");
            expect(cb).toHaveBeenCalledTimes(1);
        });

        it("fires the callback when updateProgress is called", () => {
            const id = service.addTranscription("audio.m4a");
            const cb = vi.fn();
            service.subscribe(cb);
            service.updateProgress(id, 50);
            expect(cb).toHaveBeenCalledTimes(1);
        });

        it("unsubscribe stops the callback from firing", () => {
            const cb = vi.fn();
            const unsub = service.subscribe(cb);
            unsub();
            service.addTranscription("audio.m4a");
            expect(cb).not.toHaveBeenCalled();
        });

        it("multiple subscribers each receive notifications", () => {
            const cb1 = vi.fn();
            const cb2 = vi.fn();
            service.subscribe(cb1);
            service.subscribe(cb2);
            service.addTranscription("audio.m4a");
            expect(cb1).toHaveBeenCalledTimes(1);
            expect(cb2).toHaveBeenCalledTimes(1);
        });

        it("unsubscribing one does not silence the remaining subscriber", () => {
            const cb1 = vi.fn();
            const cb2 = vi.fn();
            const unsub1 = service.subscribe(cb1);
            service.subscribe(cb2);
            unsub1();
            service.addTranscription("audio.m4a");
            expect(cb1).not.toHaveBeenCalled();
            expect(cb2).toHaveBeenCalledTimes(1);
        });
    });

    // ── addTranscription ──────────────────────────────────────────────────────

    describe("addTranscription", () => {
        it("returns a non-empty string id", () => {
            const id = service.addTranscription("audio.m4a");
            expect(typeof id).toBe("string");
            expect(id.length).toBeGreaterThan(0);
        });

        it("creates a record with type='transcription'", () => {
            service.addTranscription("audio.m4a");
            const rec = service.getAll()[0];
            expect(rec.type).toBe("transcription");
        });

        it("creates a record with status='running'", () => {
            service.addTranscription("audio.m4a");
            expect(service.getAll()[0].status).toBe("running");
        });

        it("uses the given label", () => {
            service.addTranscription("my-recording.m4a");
            expect(service.getAll()[0].label).toBe("my-recording.m4a");
        });

        it("stores the optional noteId", () => {
            service.addTranscription("audio.m4a", "note-99");
            expect(service.getAll()[0].noteId).toBe("note-99");
        });

        it("noteId is undefined when omitted", () => {
            service.addTranscription("audio.m4a");
            expect(service.getAll()[0].noteId).toBeUndefined();
        });

        it("sets startedAt to a recent Date", () => {
            const before = Date.now();
            service.addTranscription("audio.m4a");
            const after = Date.now();
            const { startedAt } = service.getAll()[0];
            expect(startedAt).toBeInstanceOf(Date);
            expect(startedAt.getTime()).toBeGreaterThanOrEqual(before);
            expect(startedAt.getTime()).toBeLessThanOrEqual(after);
        });

        it("sets completedAt to null", () => {
            service.addTranscription("audio.m4a");
            expect(service.getAll()[0].completedAt).toBeNull();
        });

        it("sets errorMessage to null", () => {
            service.addTranscription("audio.m4a");
            expect(service.getAll()[0].errorMessage).toBeNull();
        });

        it("each call produces a unique id", () => {
            const id1 = service.addTranscription("a.m4a");
            const id2 = service.addTranscription("b.m4a");
            expect(id1).not.toBe(id2);
        });
    });

    // ── addDownload ───────────────────────────────────────────────────────────

    describe("addDownload", () => {
        it("creates a record with type='download'", () => {
            service.addDownload("tiny");
            expect(service.getAll()[0].type).toBe("download");
        });

        it("creates a record with status='running'", () => {
            service.addDownload("tiny");
            expect(service.getAll()[0].status).toBe("running");
        });

        it("uses the model name as the label", () => {
            service.addDownload("small");
            expect(service.getAll()[0].label).toBe("small");
        });

        it("sets the model field", () => {
            service.addDownload("small");
            expect(service.getAll()[0].model).toBe("small");
        });

        it("stores the optional url in result", () => {
            service.addDownload("tiny", "https://example.com/ggml-tiny.bin");
            expect(service.getAll()[0].result).toBe("https://example.com/ggml-tiny.bin");
        });

        it("result is undefined when url is omitted", () => {
            service.addDownload("tiny");
            expect(service.getAll()[0].result).toBeUndefined();
        });
    });

    // ── appendDebugLog ────────────────────────────────────────────────────────

    describe("appendDebugLog", () => {
        it("appends a message to debugLog", () => {
            const id = service.addTranscription("audio.m4a");
            service.appendDebugLog(id, "loading model");
            const rec = service.getAll()[0];
            expect(rec.debugLog).toHaveLength(1);
            expect(rec.debugLog![0]).toContain("loading model");
        });

        it("prepends a HH:mm:ss.mmm timestamp to the message", () => {
            const id = service.addTranscription("audio.m4a");
            service.appendDebugLog(id, "hello");
            const entry = service.getAll()[0].debugLog![0];
            // Format: "HH:mm:ss.mmm  hello"
            expect(entry).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}\s{2}hello$/);
        });

        it("accumulates multiple messages in order", () => {
            const id = service.addTranscription("audio.m4a");
            service.appendDebugLog(id, "step 1");
            service.appendDebugLog(id, "step 2");
            service.appendDebugLog(id, "step 3");
            const { debugLog } = service.getAll()[0];
            expect(debugLog).toHaveLength(3);
            expect(debugLog![0]).toContain("step 1");
            expect(debugLog![1]).toContain("step 2");
            expect(debugLog![2]).toContain("step 3");
        });

        it("is a no-op when the id does not exist", () => {
            // Must not throw
            expect(() => service.appendDebugLog("nonexistent-id", "msg")).not.toThrow();
        });

        it("does not notify subscribers for an unknown id", () => {
            const cb = vi.fn();
            service.subscribe(cb);
            service.appendDebugLog("nonexistent-id", "msg");
            expect(cb).not.toHaveBeenCalled();
        });
    });

    // ── updateProgress ────────────────────────────────────────────────────────

    describe("updateProgress", () => {
        it("updates percent on a running record", () => {
            const id = service.addTranscription("audio.m4a");
            service.updateProgress(id, 42);
            expect(service.getAll()[0].percent).toBe(42);
        });

        it("does not update a record that is already done", async () => {
            const id = service.addTranscription("audio.m4a");
            await service.completeProcess(id);
            service.updateProgress(id, 75);
            expect(service.getAll()[0].percent).toBeUndefined();
        });

        it("does not update a record that is in error state", async () => {
            const id = service.addTranscription("audio.m4a");
            await service.completeProcess(id, "Something went wrong");
            service.updateProgress(id, 75);
            // percent was never set before completing — remains undefined
            expect(service.getAll()[0].percent).toBeUndefined();
        });

        it("is a no-op when the id does not exist", () => {
            expect(() => service.updateProgress("nonexistent-id", 50)).not.toThrow();
        });

        it("does not notify subscribers for an unknown id", () => {
            const cb = vi.fn();
            service.subscribe(cb);
            service.updateProgress("nonexistent-id", 50);
            expect(cb).not.toHaveBeenCalled();
        });

        it("notifies subscribers after a progress update on a valid record", () => {
            const id = service.addTranscription("audio.m4a");
            const cb = vi.fn();
            service.subscribe(cb);
            service.updateProgress(id, 10);
            expect(cb).toHaveBeenCalledTimes(1);
        });
    });

    // ── completeProcess (success) ─────────────────────────────────────────────

    describe("completeProcess — success", () => {
        it("marks the record as done", async () => {
            const id = service.addTranscription("audio.m4a");
            await service.completeProcess(id);
            expect(service.getAll()[0].status).toBe("done");
        });

        it("sets completedAt to a recent Date", async () => {
            const id = service.addTranscription("audio.m4a");
            const before = Date.now();
            await service.completeProcess(id);
            const after = Date.now();
            const { completedAt } = service.getAll()[0];
            expect(completedAt).toBeInstanceOf(Date);
            expect(completedAt!.getTime()).toBeGreaterThanOrEqual(before);
            expect(completedAt!.getTime()).toBeLessThanOrEqual(after);
        });

        it("sets errorMessage to null", async () => {
            const id = service.addTranscription("audio.m4a");
            await service.completeProcess(id);
            expect(service.getAll()[0].errorMessage).toBeNull();
        });

        it("stores the result string on the record", async () => {
            const id = service.addTranscription("audio.m4a");
            await service.completeProcess(id, undefined, "Bonjour le monde");
            expect(service.getAll()[0].result).toBe("Bonjour le monde");
        });

        it("persists status='done' to the database", async () => {
            const id = service.addTranscription("audio.m4a");
            await service.completeProcess(id, undefined, "persisted text");

            // Load fresh from DB
            const records = await db.getAllProcesses();
            const persisted = records.find(r => r.id === id);
            expect(persisted).toBeDefined();
            expect(persisted!.status).toBe("done");
        });

        it("persists completedAt to the database", async () => {
            const id = service.addTranscription("audio.m4a");
            await service.completeProcess(id);

            const records = await db.getAllProcesses();
            const persisted = records.find(r => r.id === id);
            expect(persisted!.completedAt).toBeInstanceOf(Date);
        });

        it("persists result to the database", async () => {
            const id = service.addTranscription("audio.m4a");
            await service.completeProcess(id, undefined, "Bonjour le monde");

            const records = await db.getAllProcesses();
            const persisted = records.find(r => r.id === id);
            expect(persisted!.result).toBe("Bonjour le monde");
        });

        it("persists the debugLog to the database", async () => {
            const id = service.addTranscription("audio.m4a");
            service.appendDebugLog(id, "step A");
            service.appendDebugLog(id, "step B");
            await service.completeProcess(id, undefined, "ok");

            const records = await db.getAllProcesses();
            const persisted = records.find(r => r.id === id);
            expect(persisted!.debugLog).toHaveLength(2);
            expect(persisted!.debugLog![0]).toContain("step A");
            expect(persisted!.debugLog![1]).toContain("step B");
        });

        it("is a no-op when the id does not exist", async () => {
            await expect(service.completeProcess("nonexistent-id")).resolves.not.toThrow();
        });
    });

    // ── completeProcess (error) ───────────────────────────────────────────────

    describe("completeProcess — error", () => {
        it("marks the record as error when errorMessage is provided", async () => {
            const id = service.addTranscription("audio.m4a");
            await service.completeProcess(id, "Network timeout");
            expect(service.getAll()[0].status).toBe("error");
        });

        it("stores the errorMessage on the in-memory record", async () => {
            const id = service.addTranscription("audio.m4a");
            await service.completeProcess(id, "Permission denied");
            expect(service.getAll()[0].errorMessage).toBe("Permission denied");
        });

        it("persists status='error' to the database", async () => {
            const id = service.addTranscription("audio.m4a");
            await service.completeProcess(id, "DB failure");

            const records = await db.getAllProcesses();
            const persisted = records.find(r => r.id === id);
            expect(persisted!.status).toBe("error");
        });

        it("persists errorMessage to the database", async () => {
            const id = service.addTranscription("audio.m4a");
            await service.completeProcess(id, "something exploded");

            const records = await db.getAllProcesses();
            const persisted = records.find(r => r.id === id);
            expect(persisted!.errorMessage).toBe("something exploded");
        });

        it("persists completedAt even for error records", async () => {
            const id = service.addTranscription("audio.m4a");
            await service.completeProcess(id, "boom");

            const records = await db.getAllProcesses();
            const persisted = records.find(r => r.id === id);
            expect(persisted!.completedAt).toBeInstanceOf(Date);
        });

        it("can also store a partial result on error", async () => {
            const id = service.addTranscription("audio.m4a");
            await service.completeProcess(id, "partial failure", "partial text");
            expect(service.getAll()[0].result).toBe("partial text");
        });
    });

    // ── clearAll ──────────────────────────────────────────────────────────────

    describe("clearAll", () => {
        it("empties the in-memory list", async () => {
            service.addTranscription("a.m4a");
            service.addTranscription("b.m4a");
            await service.clearAll();
            expect(service.getAll()).toEqual([]);
        });

        it("calls db.deleteAllProcesses()", async () => {
            const spy = vi.spyOn(db, "deleteAllProcesses");
            service.addTranscription("a.m4a");
            await service.clearAll();
            expect(spy).toHaveBeenCalledTimes(1);
        });

        it("is idempotent — calling twice does not throw", async () => {
            service.addTranscription("a.m4a");
            await service.clearAll();
            await expect(service.clearAll()).resolves.not.toThrow();
        });

        it("notifies subscribers", async () => {
            const cb = vi.fn();
            service.subscribe(cb);
            await service.clearAll();
            expect(cb).toHaveBeenCalledTimes(1);
        });
    });

    // ── idempotency / integration ─────────────────────────────────────────────

    describe("integration — full lifecycle", () => {
        it("transcription: add → progress → log → complete is fully reflected in DB", async () => {
            const id = service.addTranscription("interview.m4a", "note-7");

            service.updateProgress(id, 25);
            service.appendDebugLog(id, "loading model");
            service.updateProgress(id, 80);
            service.appendDebugLog(id, "transcribing");
            await service.completeProcess(id, undefined, "Hello world");

            // Wait for fire-and-forget insertProcess
            await new Promise(r => setTimeout(r, 0));

            const records = await db.getAllProcesses();
            const rec = records.find(r => r.id === id)!;

            expect(rec.type).toBe("transcription");
            expect(rec.status).toBe("done");
            expect(rec.label).toBe("interview.m4a");
            expect(rec.noteId).toBe("note-7");
            expect(rec.result).toBe("Hello world");
            expect(rec.errorMessage).toBeNull();
            expect(rec.completedAt).toBeInstanceOf(Date);
            expect(rec.debugLog).toHaveLength(2);
        });

        it("download: add → complete persists model and result", async () => {
            const url = "https://example.com/ggml-small.bin";
            const id = service.addDownload("small", url);
            await service.completeProcess(id, undefined, url);

            await new Promise(r => setTimeout(r, 0));

            const records = await db.getAllProcesses();
            const rec = records.find(r => r.id === id)!;

            expect(rec.type).toBe("download");
            expect(rec.model).toBe("small");
            expect(rec.result).toBe(url);
            expect(rec.status).toBe("done");
        });

        it("running two processes concurrently tracks both independently", async () => {
            const id1 = service.addTranscription("a.m4a");
            const id2 = service.addDownload("tiny");

            service.updateProgress(id1, 50);
            service.updateProgress(id2, 30);

            expect(service.getAll().find(r => r.id === id1)!.percent).toBe(50);
            expect(service.getAll().find(r => r.id === id2)!.percent).toBe(30);

            await service.completeProcess(id1, undefined, "text");
            await service.completeProcess(id2);

            expect(service.getAll().find(r => r.id === id1)!.status).toBe("done");
            expect(service.getAll().find(r => r.id === id2)!.status).toBe("done");
        });

        it("clearAll followed by adding new records works correctly", async () => {
            service.addTranscription("old.m4a");
            await service.clearAll();

            const newId = service.addTranscription("new.m4a");
            const all = service.getAll();
            expect(all).toHaveLength(1);
            expect(all[0].id).toBe(newId);
            expect(all[0].label).toBe("new.m4a");
        });
    });
});
