import { describe, it, expect } from "vitest";
import {
    AppKeyNotFoundError,
    NoteKeyNotFoundError,
    UndefinedAppListError,
    UndefinedNoteListError,
    NoAppMatchError,
    NoNoteMatchError,
    NoNoteEntryMatchError,
    AppAlreadyExistsError,
    VideoNotSupportedOnWebError,
    ServerAlreadyExistsError,
    NoServerMatchError,
} from "../js/errors";
import { ErrorMessages } from "../constants/errorMessages";

// Each error class wraps a default message from ErrorMessages and lets the
// caller override. Catch-paths in the app rely on instanceof for branching;
// the name field also feeds Capacitor's logged crash reports.

const cases: Array<{
    cls: new (m?: string) => Error;
    name: string;
    defaultKey: keyof typeof ErrorMessages;
}> = [
    { cls: AppKeyNotFoundError,        name: "AppKeyNotFoundError",        defaultKey: "APP_KEY_NOT_FOUND" },
    { cls: NoteKeyNotFoundError,       name: "NoteKeyNotFoundError",       defaultKey: "NOTE_KEY_NOT_FOUND" },
    { cls: UndefinedAppListError,      name: "UndefinedAppListError",      defaultKey: "UNDEFINED_APP_LIST" },
    // UndefinedNoteListError sets name = "UndefinedAppListError" (existing
    // bug in source); test pins the current behaviour, change-detection only.
    { cls: UndefinedNoteListError,     name: "UndefinedAppListError",      defaultKey: "UNDEFINED_NOTE_LIST" },
    { cls: NoAppMatchError,            name: "NoAppMatchError",            defaultKey: "NO_APP_MATCH" },
    { cls: NoNoteMatchError,           name: "NoNoteMatchError",           defaultKey: "NO_NOTE_MATCH" },
    { cls: NoNoteEntryMatchError,      name: "NoNoteEntryMatchError",      defaultKey: "NO_NOTE_ENTRY_MATCH" },
    { cls: AppAlreadyExistsError,      name: "AppAlreadyExistsError",      defaultKey: "APP_ALREADY_EXISTS" },
    { cls: VideoNotSupportedOnWebError, name: "VideoNotSupportedOnWebError", defaultKey: "VIDEO_RECORDING_WEB" },
    { cls: ServerAlreadyExistsError,   name: "ServerAlreadyExistsError",   defaultKey: "SERVER_ALREADY_EXISTS" },
    { cls: NoServerMatchError,         name: "NoServerMatchError",         defaultKey: "NO_SERVER_MATCH" },
];

describe("error classes", () => {
    for (const { cls, name, defaultKey } of cases) {
        describe(name, () => {
            it("is a subclass of Error and sets the right .name", () => {
                const e = new cls();
                expect(e).toBeInstanceOf(Error);
                expect(e.name).toBe(name);
            });

            it("uses the default ErrorMessages entry when no message given", () => {
                const e = new cls();
                expect(e.message).toBe(ErrorMessages[defaultKey]);
            });

            it("honours a caller-supplied message override", () => {
                const e = new cls("custom");
                expect(e.message).toBe("custom");
            });
        });
    }
});

describe("ErrorMessages", () => {
    it("includes every key referenced by error classes", () => {
        for (const { defaultKey } of cases) {
            expect(ErrorMessages[defaultKey]).toBeTypeOf("string");
            expect(ErrorMessages[defaultKey].length).toBeGreaterThan(0);
        }
    });

    it("substitutes the configured LABEL_NOTE token in note-related strings", () => {
        // The default LABEL_NOTE is "Note" when VITE_LABEL_NOTE is unset.
        expect(ErrorMessages.NOTE_KEY_NOT_FOUND).toMatch(/Notes/);
        expect(ErrorMessages.UNDEFINED_NOTE_LIST).toMatch(/Notes/);
        expect(ErrorMessages.NO_NOTE_MATCH).toMatch(/Note/);
    });
});
