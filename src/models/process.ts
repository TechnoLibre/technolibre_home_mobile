export type ProcessType = "transcription" | "download";
export type ProcessStatus = "running" | "done" | "error";

export interface ProcessRecord {
    id: string;
    type: ProcessType;
    status: ProcessStatus;
    /** Human-readable label: audio filename or model name. */
    label: string;
    startedAt: Date;
    completedAt: Date | null;
    errorMessage: string | null;
    /** Transcription only — note to navigate to. */
    noteId?: string;
    /** Download only — model name for /options/transcription navigation. */
    model?: string;
    /**
     * Transcription or download progress (0–100), only meaningful while
     * status === "running". Not stored in the database.
     */
    percent?: number;
    /**
     * Transcription result text, or the download URL.
     * Stored in the database.
     */
    result?: string;
    /**
     * In-memory only — timestamped debug messages appended during execution.
     * Not persisted; cleared when the app restarts.
     */
    debugLog?: string[];
}
