import type { ProcessRecord, ProcessType } from "../models/process";
import type { DatabaseService } from "./databaseService";

function generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Persistent log of transcription and model-download processes.
 *
 * - Records survive app restarts (stored in SQLite).
 * - Processes still flagged "running" when the app starts are automatically
 *   marked as interrupted (the native side was killed).
 * - In-memory cache is kept in chronological order (oldest first);
 *   getAll() reverses it so callers see newest first.
 */
export class ProcessService {
    private db: DatabaseService;
    private _records: ProcessRecord[] = [];
    private _subscribers = new Set<() => void>();

    constructor(db: DatabaseService) {
        this.db = db;
    }

    /**
     * Must be called once after construction (after the DB migration has run).
     * Marks interrupted processes and loads the full history from SQLite.
     */
    async initialize(): Promise<void> {
        await this.db.markInterruptedProcesses();
        this._records = await this.db.getAllProcesses();
        this._notify();
    }

    // ── Public reads ─────────────────────────────────────────────────────────

    /** All records, most recent first. */
    getAll(): ProcessRecord[] {
        return [...this._records].reverse();
    }

    /**
     * Subscribe to list changes (start, completion, error).
     * Returns an unsubscribe function.
     */
    subscribe(cb: () => void): () => void {
        this._subscribers.add(cb);
        return () => this._subscribers.delete(cb);
    }

    // ── Lifecycle helpers (called by TranscriptionService) ───────────────────

    addTranscription(label: string, noteId?: string): string {
        return this._add("transcription", label, { noteId });
    }

    addDownload(model: string, url?: string, mode?: "wakelock" | "foreground"): string {
        return this._add("download", model, { model, result: url, downloadMode: mode ?? "wakelock" });
    }

    /**
     * Append a timestamped debug message to the in-memory log of a process.
     * Persisted to SQLite when the process completes (completeProcess).
     */
    appendDebugLog(id: string, message: string): void {
        const rec = this._find(id);
        if (!rec) return;
        if (!rec.debugLog) rec.debugLog = [];
        const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.mmm
        rec.debugLog.push(`${ts}  ${message}`);
        this._notify();
    }

    /**
     * Update in-memory progress for a running process.
     * No DB write — progress is transient and changes too frequently.
     */
    updateProgress(id: string, percent: number): void {
        const rec = this._find(id);
        if (!rec || rec.status !== "running") return;
        rec.percent = percent;
        this._notify();
    }

    /** Mark a process as done or errored and persist the result and debug log. */
    async completeProcess(id: string, errorMessage?: string, result?: string): Promise<void> {
        const rec = this._find(id);
        if (!rec) return;

        rec.status       = errorMessage ? "error" : "done";
        rec.completedAt  = new Date();
        rec.errorMessage = errorMessage ?? null;
        if (result !== undefined) rec.result = result;

        await this.db.updateProcessStatus(
            id, rec.status, rec.completedAt, rec.errorMessage, rec.result, rec.debugLog
        );
        this._notify();
    }

    /** Delete all records from memory and the database. */
    async clearAll(): Promise<void> {
        this._records = [];
        await this.db.deleteAllProcesses();
        this._notify();
    }

    // ── Private ──────────────────────────────────────────────────────────────

    private _add(type: ProcessType, label: string, extra: Partial<ProcessRecord>): string {
        const id = generateId();
        const record: ProcessRecord = {
            id,
            type,
            status:       "running",
            label,
            startedAt:    new Date(),
            completedAt:  null,
            errorMessage: null,
            ...extra,
        };
        this._records.push(record);
        // Fire-and-forget: DB write must not block the caller.
        this.db.insertProcess(record).catch((e) =>
            console.warn("[ProcessService] insertProcess failed:", e)
        );
        this._notify();
        return id;
    }

    private _find(id: string): ProcessRecord | undefined {
        return this._records.find(r => r.id === id);
    }

    private _notify(): void {
        this._subscribers.forEach(cb => cb());
    }
}
