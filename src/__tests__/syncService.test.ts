import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "../services/databaseService";
import {
  SyncService, SyncCredentials, syncSessionKey, syncConfigIdOf, RemoteRecordDeletedError,
  TASK_CREATE, LEAD_CREATE, ACTIVITY_CREATE, MESSAGE_POST, INVOICE_CREATE, clientMarker, SyncConflictError,
} from "../services/syncService";
import { OutboxBlockedError } from "../services/outboxService";
import { Note, NoteEntry } from "../models/note";
import { syncConfigIdFor } from "../models/syncConfig";
import { addNoteLinksTable } from "../services/migrations/addNoteLinksTable";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CREDS: SyncCredentials = {
  odooUrl: "https://odoo.example.com",
  username: "admin",
  password: "secret",
  database: "mydb",
};

const BASE_NOTE: Note = {
  id: "note-uuid-1",
  title: "Test note",
  done: false,
  archived: false,
  pinned: false,
  tags: [],
  entries: [],
};

function makeNote(overrides: Partial<Note> = {}): Note {
  return { ...BASE_NOTE, ...overrides };
}

const CONFIG_ID = syncConfigIdOf(CREDS);
/** The same url and user, on the database the application used before. */
const OLD_DB_CONFIG_ID = syncConfigIdFor(CREDS.odooUrl, CREDS.username, "olddb");

/** Schema a migrated install has for sync: columns, links, outbox, probes, targets. */
async function prepareSyncDb(db: DatabaseService, apps: SyncCredentials[] = [CREDS]): Promise<void> {
  await db.addSyncColumnsToNotes();
  await db.addSyncConfigIdColumn();
  await db.addSelectedSyncConfigIdsColumn();
  await db.addSyncPerServerStatusColumn();
  await db.addSyncFieldsToApplications();
  await db.addNtfyTokenColumn();
  await db.createNoteLinksTable();
  await db.createSyncPullCursorsTable();
  await db.createSyncOutboxTable();
  await db.createServerCapabilitiesTable();
  await db.createRemoteRecordsCacheTable();
  await db.createSyncTargetPrefsTable();
  await db.createTagsTable();
  for (const c of apps) await addApp(db, c);
}

/** Registers the application behind a set of credentials (a live sync config). */
async function addApp(db: DatabaseService, c: SyncCredentials): Promise<void> {
  await db.addApplication({
    url: c.odooUrl, username: c.username, password: c.password, database: c.database,
    odooVersion: "", autoSync: false, pollIntervalMinutes: 5, ntfyUrl: "", ntfyTopic: "", ntfyToken: "",
  } as any);
}

/** Binds a note to a project.task on the given sync target. */
async function linkTask(db: DatabaseService, noteId: string, resId: number, configId = CONFIG_ID): Promise<void> {
  await db.addNoteLink({
    id: `link-${noteId}-${configId}`,
    noteId,
    configId,
    model: "project.task",
    resId,
    kind: "create",
    remoteState: "ok",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSyncedAt: "2026-01-01T00:00:00.000Z",
  });
}

function mockFetch(responseBody: object, status = 200, extraHeaders: Record<string, string> = {}) {
  // The CapacitorHttp mock in @capacitor/core delegates to fetch,
  // then parses the body as JSON. So we still mock global.fetch here.
  const bodyText = JSON.stringify(responseBody);
  // Provide a Headers-like forEach so rawPost()'s fetch fallback path doesn't crash.
  const headerMap = new Map(Object.entries(extraHeaders));
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => bodyText,
    headers: { forEach: (cb: (value: string, key: string) => void) => headerMap.forEach((v, k) => cb(v, k)) },
  } as unknown as Response);
}

// ─── buildHtml ────────────────────────────────────────────────────────────────

describe("SyncService.buildHtml", () => {
  let svc: SyncService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    const db = new DatabaseService();
    await db.initialize();
    svc = new SyncService(db);
  });

  it("returns empty string for empty entries", () => {
    expect(svc.buildHtml([])).toBe("");
  });

  it("wraps each text entry in a <p>", () => {
    const entries: NoteEntry[] = [
      { id: "e1", type: "text", params: { text: "Hello world", readonly: false } },
      { id: "e2", type: "text", params: { text: "Second line", readonly: false } },
    ];
    const html = svc.buildHtml(entries);
    expect(html).toContain("<p>Hello world</p>");
    expect(html).toContain("<p>Second line</p>");
  });

  it("skips blank text entries", () => {
    const entries: NoteEntry[] = [
      { id: "e1", type: "text", params: { text: "   ", readonly: false } },
    ];
    expect(svc.buildHtml(entries)).toBe("");
  });

  it("escapes HTML special characters in text entries", () => {
    const entries: NoteEntry[] = [
      { id: "e1", type: "text", params: { text: "<script>alert('xss')</script>", readonly: false } },
    ];
    const html = svc.buildHtml(entries);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders date entry as emoji paragraph", () => {
    const entries: NoteEntry[] = [
      { id: "e1", type: "date", params: { date: "2026-03-30T10:00:00.000Z" } },
    ];
    const html = svc.buildHtml(entries);
    expect(html).toContain("📅");
    expect(html).toContain("2026-03-30T10:00:00.000Z");
  });

  it("renders geolocation entry with coordinates and text", () => {
    const entries: NoteEntry[] = [
      {
        id: "e1",
        type: "geolocation",
        params: { text: "Bureau", latitude: 45.5017, longitude: -73.5673, timestamp: 1743000000000 },
      },
    ];
    const html = svc.buildHtml(entries);
    expect(html).toContain("📍");
    expect(html).toContain("45.5017");
    expect(html).toContain("-73.5673");
    expect(html).toContain("Bureau");
  });

  it("renders audio, photo, video entries as emoji lines", () => {
    const entries: NoteEntry[] = [
      { id: "e1", type: "audio", params: { path: "/audio.m4a" } },
      { id: "e2", type: "photo", params: { path: "/photo.jpg" } },
      { id: "e3", type: "video", params: { path: "/video.mp4" } },
    ];
    const html = svc.buildHtml(entries);
    expect(html).toContain("🎙️");
    expect(html).toContain("📷");
    expect(html).toContain("🎥");
  });

  it("renders mixed entries in order", () => {
    const entries: NoteEntry[] = [
      { id: "e1", type: "text", params: { text: "First", readonly: false } },
      { id: "e2", type: "audio", params: { path: "/audio.m4a" } },
      { id: "e3", type: "text", params: { text: "Last", readonly: false } },
    ];
    const html = svc.buildHtml(entries);
    const firstIdx = html.indexOf("First");
    const audioIdx = html.indexOf("🎙️");
    const lastIdx = html.indexOf("Last");
    expect(firstIdx).toBeLessThan(audioIdx);
    expect(audioIdx).toBeLessThan(lastIdx);
  });
});

// ─── buildGeoMultiPoint ───────────────────────────────────────────────────────

describe("SyncService.buildGeoMultiPoint", () => {
  let svc: SyncService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    const db = new DatabaseService();
    await db.initialize();
    svc = new SyncService(db);
  });

  it("returns null when there are no geolocation entries", () => {
    const entries: NoteEntry[] = [
      { id: "e1", type: "text", params: { text: "no geo", readonly: false } },
    ];
    expect(svc.buildGeoMultiPoint(entries)).toBeNull();
  });

  it("returns null for empty entries", () => {
    expect(svc.buildGeoMultiPoint([])).toBeNull();
  });

  it("returns a GeoJSON MultiPoint for a single geolocation entry", () => {
    const entries: NoteEntry[] = [
      {
        id: "e1",
        type: "geolocation",
        params: { text: "Home", latitude: 45.5, longitude: -73.5, timestamp: 1000 },
      },
    ];
    const result = svc.buildGeoMultiPoint(entries);
    expect(result).not.toBeNull();
    const geo = JSON.parse(result!);
    expect(geo.type).toBe("MultiPoint");
    expect(geo.coordinates).toHaveLength(1);
    expect(geo.coordinates[0]).toEqual([-73.5, 45.5]); // [lon, lat] per GeoJSON spec
  });

  it("collects all geolocation entries into one MultiPoint", () => {
    const entries: NoteEntry[] = [
      {
        id: "e1",
        type: "geolocation",
        params: { text: "A", latitude: 45.0, longitude: -73.0, timestamp: 1000 },
      },
      { id: "e2", type: "text", params: { text: "between", readonly: false } },
      {
        id: "e3",
        type: "geolocation",
        params: { text: "B", latitude: 46.0, longitude: -74.0, timestamp: 2000 },
      },
    ];
    const geo = JSON.parse(svc.buildGeoMultiPoint(entries)!);
    expect(geo.coordinates).toHaveLength(2);
    expect(geo.coordinates[0]).toEqual([-73.0, 45.0]);
    expect(geo.coordinates[1]).toEqual([-74.0, 46.0]);
  });

  it("uses [longitude, latitude] order per GeoJSON spec", () => {
    const entries: NoteEntry[] = [
      {
        id: "e1",
        type: "geolocation",
        params: { text: "X", latitude: 10, longitude: 20, timestamp: 0 },
      },
    ];
    const geo = JSON.parse(svc.buildGeoMultiPoint(entries)!);
    const [lon, lat] = geo.coordinates[0];
    expect(lon).toBe(20);
    expect(lat).toBe(10);
  });
});

// ─── SyncService — authenticate ───────────────────────────────────────────────

describe("SyncService.authenticate", () => {
  let svc: SyncService;
  let db: DatabaseService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    svc = new SyncService(db);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores session ID in SecureStorage on success", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ result: { uid: 1, session_id: "sess-abc123", server_version_info: [18, 0] } })
    );
    const stored = await svc.authenticate(CREDS);
    expect(stored.sessionId).toBe("sess-abc123");
    expect(stored.odooMajorVersion).toBe(18);
    // Session stored as JSON in SecureStorage
    const allValues = Array.from(SecureStoragePlugin._store.values()) as string[];
    expect(allValues.some((v) => v.includes("sess-abc123"))).toBe(true);
  });

  it("throws when uid is falsy (wrong credentials)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ result: { uid: false, session_id: "" } })
    );
    await expect(svc.authenticate(CREDS)).rejects.toThrow(/Authentication failed/);
  });

  it("throws when Odoo returns a JSON-RPC error", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ error: { message: "Access denied", data: { message: "Wrong password" } } })
    );
    await expect(svc.authenticate(CREDS)).rejects.toThrow(/Wrong password/);
  });
});

// ─── SyncService — pushNote ───────────────────────────────────────────────────

describe("SyncService.pushNote", () => {
  let svc: SyncService;
  let db: DatabaseService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await prepareSyncDb(db);
    svc = new SyncService(db);
    // Pre-store a session so authenticate is not called
    await SecureStoragePlugin.set({
      key: syncSessionKey(CREDS),
      value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 18 }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls project.task.create on first push and links the task to this server", async () => {
    const note = makeNote({ id: "note-1", title: "My Note" });
    await db.addNote(note);

    vi.stubGlobal("fetch", mockFetch({ result: 42 }));

    await svc.pushNote(CREDS, "note-1");

    const links = await db.getNoteLinks("note-1");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ configId: CONFIG_ID, model: "project.task", resId: 42, kind: "create" });
    const info = await db.getNoteSyncInfo("note-1");
    expect(info.syncStatus).toBe("synced");
    expect(info.lastSyncedAt).not.toBeNull();
    expect(await db.getNotePerServerStatus("note-1")).toEqual({ [CONFIG_ID]: "synced" });
  });

  it("calls project.task.write on subsequent push (task linked on this server)", async () => {
    const note = makeNote({ id: "note-2", title: "Existing" });
    await db.addNote(note);
    await linkTask(db, "note-2", 99);

    const fetchMock = mockFetch({ result: true });
    vi.stubGlobal("fetch", fetchMock);

    await svc.pushNote(CREDS, "note-2");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.params.method).toBe("write");
    expect(body.params.args[0]).toEqual([99]);
  });

  it("sets sync_status to error when RPC fails", async () => {
    const note = makeNote({ id: "note-3" });
    await db.addNote(note);

    vi.stubGlobal("fetch", mockFetch({ error: { message: "Server error", data: { message: "boom" } } }));

    await expect(svc.pushNote(CREDS, "note-3")).rejects.toThrow();
  });

  it("throws when note does not exist in DB", async () => {
    vi.stubGlobal("fetch", mockFetch({ result: 1 }));
    await expect(svc.pushNote(CREDS, "ghost-id")).rejects.toThrow(/not found/);
  });

  it("sets project_id to false (project_todo)", async () => {
    const note = makeNote({ id: "note-4" });
    await db.addNote(note);

    const fetchMock = mockFetch({ result: 77 });
    vi.stubGlobal("fetch", fetchMock);

    await svc.pushNote(CREDS, "note-4");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.params.args[0].project_id).toBe(false);
  });

  it("maps pinned=true to priority='1'", async () => {
    const note = makeNote({ id: "note-5", pinned: true });
    await db.addNote(note);

    const fetchMock = mockFetch({ result: 55 });
    vi.stubGlobal("fetch", fetchMock);

    await svc.pushNote(CREDS, "note-5");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.params.args[0].priority).toBe("1");
  });

  it("maps done=true to state='1_done' (Odoo 17+ closed state)", async () => {
    const note = makeNote({ id: "note-6", done: true });
    await db.addNote(note);

    const fetchMock = mockFetch({ result: 66 });
    vi.stubGlobal("fetch", fetchMock);

    await svc.pushNote(CREDS, "note-6");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.params.args[0].state).toBe("1_done");
  });
});

// ─── SyncService — pollForChanges ─────────────────────────────────────────────

describe("SyncService.pollForChanges", () => {
  let svc: SyncService;
  let db: DatabaseService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await prepareSyncDb(db);
    svc = new SyncService(db);
    await SecureStoragePlugin.set({
      key: syncSessionKey(CREDS),
      value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 18 }),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("returns empty array when no changes", async () => {
    vi.stubGlobal("fetch", mockFetch({ result: [] }));
    const ids = await svc.pollForChanges(CREDS, new Date());
    expect(ids).toEqual([]);
  });

  it("returns the ids of the changed linked tasks, whatever their project", async () => {
    for (const [noteId, resId] of [["po-1", 10], ["po-2", 20]] as const) {
      await db.addNote(makeNote({ id: noteId }));
      await linkTask(db, noteId, resId);
    }
    const fetchMock = mockFetch({ result: [{ id: 10, write_date: "2026-03-30" }, { id: 20, write_date: "2026-03-30" }] });
    vi.stubGlobal("fetch", fetchMock);
    const ids = await svc.pollForChanges(CREDS, new Date("2026-03-29"));
    expect(ids).toEqual([10, 20]);
    const domain = JSON.parse(fetchMock.mock.calls[0][1].body).params.kwargs.domain;
    expect(domain[0]).toEqual(["id", "in", [10, 20]]);
  });

  it("sends nothing when no task is linked on the server", async () => {
    const fetchMock = mockFetch({ result: [{ id: 10, write_date: "2026-03-30" }] });
    vi.stubGlobal("fetch", fetchMock);
    expect(await svc.pollForChanges(CREDS, new Date("2026-03-29"))).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── SyncService — pullNotes ──────────────────────────────────────────────────

describe("SyncService.pullNotes", () => {
  let svc: SyncService;
  let db: DatabaseService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await prepareSyncDb(db);
    svc = new SyncService(db);
    await SecureStoragePlugin.set({
      key: syncSessionKey(CREDS),
      value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 18 }),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("updates title and pinned from Odoo task", async () => {
    const note = makeNote({ id: "pull-1", title: "Old Title", pinned: false });
    await db.addNote(note);
    await linkTask(db, "pull-1", 10);

    vi.stubGlobal("fetch", mockFetch({
      result: [{ id: 10, name: "New Title", priority: "1", active: true, tag_ids: [], date_deadline: null, write_date: "2026-04-10" }],
    }));

    const updated = await svc.pullNotes(CREDS, new Date(0));
    expect(updated).toBe(1);

    const refreshed = await db.getNoteById("pull-1");
    expect(refreshed!.title).toBe("New Title");
    expect(refreshed!.pinned).toBe(true);
  });

  it("skips tasks not linked on this server", async () => {
    const note = makeNote({ id: "pull-2", title: "Local" });
    await db.addNote(note);
    await linkTask(db, "pull-2", 99);

    vi.stubGlobal("fetch", mockFetch({
      result: [{ id: 55, name: "Remote Only", priority: "0", active: true, tag_ids: [], write_date: "2026-04-10" }],
    }));

    const updated = await svc.pullNotes(CREDS, new Date(0));
    expect(updated).toBe(0);

    const refreshed = await db.getNoteById("pull-2");
    expect(refreshed!.title).toBe("Local");
  });

  it("maps archived state from active=false", async () => {
    const note = makeNote({ id: "pull-3", archived: false });
    await db.addNote(note);
    await linkTask(db, "pull-3", 20);

    vi.stubGlobal("fetch", mockFetch({
      result: [{ id: 20, name: "Test note", priority: "0", active: false, tag_ids: [], write_date: "2026-04-10" }],
    }));

    await svc.pullNotes(CREDS, new Date(0));
    const refreshed = await db.getNoteById("pull-3");
    expect(refreshed!.archived).toBe(true);
  });

  it("sets done from state='1_done' on Odoo 17+", async () => {
    SecureStoragePlugin._store.clear();
    await SecureStoragePlugin.set({
      key: syncSessionKey(CREDS),
      value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 17 }),
    });

    const note = makeNote({ id: "pull-4", done: false });
    await db.addNote(note);
    await linkTask(db, "pull-4", 30);

    vi.stubGlobal("fetch", mockFetch({
      result: [{ id: 30, name: "Test note", priority: "0", active: true, state: "1_done", tag_ids: [], write_date: "2026-04-10" }],
    }));

    await svc.pullNotes(CREDS, new Date(0));
    const refreshed = await db.getNoteById("pull-4");
    expect(refreshed!.done).toBe(true);
  });

  it("returns 0 when Odoo returns no changes", async () => {
    vi.stubGlobal("fetch", mockFetch({ result: [] }));
    const updated = await svc.pullNotes(CREDS, new Date());
    expect(updated).toBe(0);
  });
});

// ─── SyncService — listDatabases ─────────────────────────────────────────────

describe("SyncService.listDatabases", () => {
  let svc: SyncService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    const db = new DatabaseService();
    await db.initialize();
    svc = new SyncService(db);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("returns an array of database names on success", async () => {
    vi.stubGlobal("fetch", mockFetch({ result: ["mydb", "testdb"] }));
    const dbs = await svc.listDatabases(CREDS.odooUrl);
    expect(dbs).toEqual(["mydb", "testdb"]);
  });

  it("returns an empty array when result is not an array", async () => {
    vi.stubGlobal("fetch", mockFetch({ result: null }));
    const dbs = await svc.listDatabases(CREDS.odooUrl);
    expect(dbs).toEqual([]);
  });

  it("returns an empty array when result is missing", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    const dbs = await svc.listDatabases(CREDS.odooUrl);
    expect(dbs).toEqual([]);
  });

  it("throws when server returns a JSON-RPC error", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ error: { message: "Access denied", data: { message: "Not allowed" } } })
    );
    await expect(svc.listDatabases(CREDS.odooUrl)).rejects.toThrow(/Not allowed/);
  });
});

// ─── SyncService — getServerVersion ──────────────────────────────────────────

describe("SyncService.getServerVersion", () => {
  let svc: SyncService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    const db = new DatabaseService();
    await db.initialize();
    svc = new SyncService(db);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("returns the version string on success", async () => {
    vi.stubGlobal("fetch", mockFetch({ result: { server_version: "17.0+e" } }));
    const version = await svc.getServerVersion(CREDS.odooUrl);
    expect(version).toBe("17.0+e");
  });

  it("returns null when result is missing server_version", async () => {
    vi.stubGlobal("fetch", mockFetch({ result: {} }));
    const version = await svc.getServerVersion(CREDS.odooUrl);
    expect(version).toBeNull();
  });

  it("returns null when the response has an error", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ error: { message: "Not found", data: { message: "404" } } })
    );
    const version = await svc.getServerVersion(CREDS.odooUrl);
    expect(version).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const version = await svc.getServerVersion(CREDS.odooUrl);
    expect(version).toBeNull();
  });
});

// ─── SyncService — getOdooExplorer ───────────────────────────────────────────

describe("SyncService.getOdooExplorer", () => {
  let svc: SyncService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    const db = new DatabaseService();
    await db.initialize();
    svc = new SyncService(db);
    await SecureStoragePlugin.set({
      key: syncSessionKey(CREDS),
      value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 18 }),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("returns version string and model list", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        result: [
          { name: "Task", model: "project.task" },
          { name: "Contact", model: "res.partner" },
        ],
      })
    );
    const explorer = await svc.getOdooExplorer(CREDS);
    expect(explorer.version).toBe("Odoo 18");
    expect(explorer.models).toHaveLength(2);
    expect(explorer.models[0].model).toBe("project.task");
  });

  it("returns empty model list when RPC returns empty array", async () => {
    vi.stubGlobal("fetch", mockFetch({ result: [] }));
    const explorer = await svc.getOdooExplorer(CREDS);
    expect(explorer.models).toHaveLength(0);
  });
});

// ─── SyncService — getOdooModelInfo ──────────────────────────────────────────

describe("SyncService.getOdooModelInfo", () => {
  let svc: SyncService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    const db = new DatabaseService();
    await db.initialize();
    svc = new SyncService(db);
    await SecureStoragePlugin.set({
      key: syncSessionKey(CREDS),
      value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 18 }),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("returns field definitions and record count", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        text: async () => JSON.stringify({
          result: [
            { name: "name", field_description: "Task Title", ttype: "char" },
            { name: "state", field_description: "State", ttype: "selection" },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        text: async () => JSON.stringify({ result: 42 }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const info = await svc.getOdooModelInfo(CREDS, "project.task");
    expect(info.count).toBe(42);
    expect(info.fields).toHaveLength(2);
    expect(info.fields[0].name).toBe("name");
    expect(info.fields[0].fieldDescription).toBe("Task Title");
    expect(info.fields[0].ttype).toBe("char");
  });

  it("returns count=-1 when search_count fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        text: async () => JSON.stringify({ result: [] }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        text: async () => JSON.stringify({ error: { message: "forbidden", data: { message: "no access" } } }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const info = await svc.getOdooModelInfo(CREDS, "private.model");
    expect(info.count).toBe(-1);
    expect(info.fields).toHaveLength(0);
  });
});

// ─── SyncService — syncAll ────────────────────────────────────────────────────

describe("SyncService.syncAll", () => {
  let svc: SyncService;
  let db: DatabaseService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await prepareSyncDb(db);
    svc = new SyncService(db);
    await SecureStoragePlugin.set({
      key: syncSessionKey(CREDS),
      value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 18 }),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("pushes pending notes and returns pushed count", async () => {
    const note = makeNote({ id: "sa-1", title: "Pending" });
    await db.addNote(note);
    await db.markNotePendingForConfigs("sa-1", [CONFIG_ID]);

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ result: 7 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ result: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await svc.syncAll(CREDS);
    expect(result.pushed).toBe(1);
    expect(result.pulled).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("does not push notes with status other than pending", async () => {
    const note = makeNote({ id: "sa-2" });
    await db.addNote(note);
    await linkTask(db, "sa-2", 2);
    await db.setNotePerServerStatus("sa-2", CONFIG_ID, "synced");
    await db.setNoteSyncInfo("sa-2", { syncStatus: "synced" });

    vi.stubGlobal("fetch", mockFetch({ result: [] }));

    const result = await svc.syncAll(CREDS);
    expect(result.pushed).toBe(0);
  });

  it("records error when a push fails and continues", async () => {
    await db.addNote(makeNote({ id: "sa-3", title: "Fail" }));
    await db.markNotePendingForConfigs("sa-3", [CONFIG_ID]);
    await db.addNote(makeNote({ id: "sa-4", title: "Ok" }));
    await db.markNotePendingForConfigs("sa-4", [CONFIG_ID]);

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ error: { message: "boom", data: { message: "Server exploded" } } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ result: 9 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ result: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await svc.syncAll(CREDS);
    expect(result.pushed).toBe(1);
    expect(result.errors).toHaveLength(1);
  });

  it("uses syncConfigId to filter notes when provided", async () => {
    const configId = `${CREDS.odooUrl}|${CREDS.username}`;
    await db.addNote(makeNote({ id: "sa-5" }));
    await db.markNotePendingForConfigs("sa-5", [configId]);
    await db.addNote(makeNote({ id: "sa-6" }));
    await db.markNotePendingForConfigs("sa-6", ["https://other.example.com|admin|otherdb"]);

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ result: 5 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ result: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await svc.syncAll(CREDS, configId);
    expect(result.pushed).toBe(1);
  });
});

// ─── Per-server binding, pending queue, session handling ─────────────────────

const OTHER_CREDS: SyncCredentials = {
  odooUrl: "https://other.example.com",
  username: "admin",
  password: "secret",
  database: "otherdb",
};
const OTHER_CONFIG_ID = syncConfigIdOf(OTHER_CREDS);

type RpcBody = { params: { model?: string; method?: string; args?: any[]; login?: string } };

/** fetch mock answering each call through handler(url, parsed JSON body). */
function routeFetch(handler: (url: string, body: RpcBody) => object) {
  return vi.fn(async (url: string, opts: { body: string }) => {
    const bodyText = JSON.stringify(handler(url, JSON.parse(opts.body)));
    return {
      ok: true,
      status: 200,
      text: async () => bodyText,
      headers: { forEach: () => {} },
    } as unknown as Response;
  });
}


/** Moves the clock past the quiet window a create retry waits (3 min). */
function afterQuietWindow(): void {
  vi.setSystemTime(Date.now() + 4 * 60 * 1000);
}

const rpcCalls = (fetchMock: ReturnType<typeof routeFetch>) =>
  fetchMock.mock.calls.map(([url, opts]) => ({ url, body: JSON.parse(opts.body) as RpcBody }));

describe("SyncService — per-server binding", () => {
  let svc: SyncService;
  let db: DatabaseService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await prepareSyncDb(db, [CREDS, OTHER_CREDS]);
    svc = new SyncService(db);
    for (const creds of [CREDS, OTHER_CREDS]) {
      await SecureStoragePlugin.set({
        key: syncSessionKey(creds),
        value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 18 }),
      });
    }
  });

  afterEach(() => vi.unstubAllGlobals());

  it("creates a new task on a second server instead of writing the first server's id", async () => {
    await db.addNote(makeNote({ id: "ps-1" }));
    await linkTask(db, "ps-1", 42);

    const fetchMock = routeFetch(() => ({ result: 7 }));
    vi.stubGlobal("fetch", fetchMock);

    await svc.pushNote(OTHER_CREDS, "ps-1");

    const [call] = rpcCalls(fetchMock);
    expect(call.url).toContain("other.example.com");
    expect(call.body.params.method).toBe("create");
    const links = await db.getNoteLinks("ps-1");
    expect(links.map((l) => [l.configId, l.resId]).sort()).toEqual(
      [[CONFIG_ID, 42], [OTHER_CONFIG_ID, 7]].sort()
    );
  });

  it("writes each server's own task id", async () => {
    await db.addNote(makeNote({ id: "ps-2" }));
    await linkTask(db, "ps-2", 42);
    await linkTask(db, "ps-2", 7, OTHER_CONFIG_ID);

    const fetchMock = routeFetch(() => ({ result: true }));
    vi.stubGlobal("fetch", fetchMock);

    await svc.pushNote(CREDS, "ps-2");
    await svc.pushNote(OTHER_CREDS, "ps-2");

    const writes = rpcCalls(fetchMock).map((c) => [c.url.includes("other") ? "other" : "main", c.body.params.args![0]]);
    expect(writes).toEqual([["main", [42]], ["other", [7]]]);
  });

  it("pulls only into notes linked on the pulled server", async () => {
    await db.addNote(makeNote({ id: "ps-3", title: "Mine" }));
    await linkTask(db, "ps-3", 10, OTHER_CONFIG_ID);

    vi.stubGlobal("fetch", routeFetch(() => ({
      result: [{ id: 10, name: "From main", priority: "0", active: true, tag_ids: [], write_date: "2026-04-10" }],
    })));

    expect(await svc.pullNotes(CREDS, new Date(0))).toBe(0);
    expect((await db.getNoteById("ps-3"))!.title).toBe("Mine");
  });
});

describe("SyncService — pull scope and cursor", () => {
  let svc: SyncService;
  let db: DatabaseService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await prepareSyncDb(db);
    svc = new SyncService(db);
    await SecureStoragePlugin.set({
      key: syncSessionKey(CREDS),
      value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 18 }),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  const task = (id: number, name: string, writeDate = "2026-04-10 10:00:00") =>
    ({ id, name, priority: "0", active: true, tag_ids: [], write_date: writeDate });

  it("leaves a note pending for this server untouched", async () => {
    await db.addNote(makeNote({ id: "pl-1", title: "Local edit" }));
    await linkTask(db, "pl-1", 10);
    await db.markNotePendingForConfigs("pl-1", [CONFIG_ID]);

    vi.stubGlobal("fetch", routeFetch(() => ({ result: [task(10, "Server title")] })));
    expect(await svc.pullNotes(CREDS, new Date(0))).toBe(0);

    expect((await db.getNoteById("pl-1"))!.title).toBe("Local edit");
    expect(await db.getNotePerServerStatus("pl-1")).toEqual({ [CONFIG_ID]: "pending" });
  });

  it("does not map tasks of another database onto links of the old one", async () => {
    await db.addNote(makeNote({ id: "pl-2", title: "Mine" }));
    await linkTask(db, "pl-2", 10, OLD_DB_CONFIG_ID);

    vi.stubGlobal("fetch", routeFetch(() => ({ result: [task(10, "Unrelated")] })));
    expect(await svc.pullNotes(CREDS, new Date(0))).toBe(0);
    expect((await db.getNoteById("pl-2"))!.title).toBe("Mine");
  });

  it("creates a new task after the application switched database", async () => {
    await db.addNote(makeNote({ id: "pl-3" }));
    await linkTask(db, "pl-3", 10, OLD_DB_CONFIG_ID);
    const fetchMock = routeFetch(() => ({ result: 77 }));
    vi.stubGlobal("fetch", fetchMock);

    await svc.pushNote(CREDS, "pl-3");
    expect(rpcCalls(fetchMock)[0].body.params.method).toBe("create");
  });

  it("reads archived tasks, so archiving on the server reaches the note", async () => {
    await db.addNote(makeNote({ id: "pl-4" }));
    await linkTask(db, "pl-4", 10);
    const fetchMock = routeFetch(() => ({ result: [{ ...task(10, "T"), active: false }] }));
    vi.stubGlobal("fetch", fetchMock);

    await svc.pullNotes(CREDS, new Date(0));
    expect((rpcCalls(fetchMock)[0].body.params as any).kwargs.context).toEqual({ active_test: false });
    expect((await db.getNoteById("pl-4"))!.archived).toBe(true);
  });

  it("pages from the last write_date read, excluding the ids already read at it", async () => {
    await db.addNote(makeNote({ id: "pl-5" }));
    await linkTask(db, "pl-5", 150);
    const fetchMock = routeFetch((_url, body) => {
      const domain = (body.params as any).kwargs.domain;
      const ids = domain.length > 2 ? [150] : Array.from({ length: 100 }, (_, i) => i + 1);
      return { result: ids.map((id) => task(id, `T${id}`)) };
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await svc.pullNotes(CREDS, new Date(0))).toBe(1);
    const domains = rpcCalls(fetchMock).map((c) => (c.body.params as any).kwargs.domain);
    expect(domains[1]).toEqual([
      ["id", "in", [150]],
      ["write_date", ">=", "2026-04-10 10:00:00"],
      ["id", "not in", Array.from({ length: 100 }, (_, i) => i + 1)],
    ]);
  });

  it("starts the next pull at the highest write_date already read", async () => {
    await db.addNote(makeNote({ id: "pl-6" }));
    await linkTask(db, "pl-6", 10);
    const fetchMock = routeFetch(() => ({ result: [task(10, "T", "2026-05-01 08:00:00")] }));
    vi.stubGlobal("fetch", fetchMock);

    await svc.syncAll(CREDS);
    await svc.syncAll(CREDS);

    const sinces = rpcCalls(fetchMock).map((c) => (c.body.params as any).kwargs.domain[1][2]);
    // First pull: a day before the oldest link's (device-clock) sync
    expect(sinces).toEqual(["2025-12-31T00:00:00.000Z", "2026-05-01 08:00:00"]);
  });
});

describe("SyncService — concurrent edits, deleted tasks, several servers", () => {
  let svc: SyncService;
  let db: DatabaseService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await prepareSyncDb(db, [CREDS, OTHER_CREDS]);
    svc = new SyncService(db);
    for (const creds of [CREDS, OTHER_CREDS]) {
      await SecureStoragePlugin.set({
        key: syncSessionKey(creds),
        value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 18 }),
      });
    }
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps the server pending when the note changed while its push ran", async () => {
    await db.addNote(makeNote({ id: "ce-1", title: "A" }));
    await linkTask(db, "ce-1", 5);
    vi.stubGlobal("fetch", routeFetch((_url, body) => {
      if (body.params.method === "write") {
        // The user edits the note while write() is on the wire
        void db.updateNote("ce-1", makeNote({ id: "ce-1", title: "B" }));
      }
      return { result: true };
    }));

    await svc.pushNote(CREDS, "ce-1");
    expect(await db.getNotePerServerStatus("ce-1")).toEqual({ [CONFIG_ID]: "pending" });
  });

  it("does not lose a pending mark written while another status write is in flight", async () => {
    await db.addNote(makeNote({ id: "ce-2" }));
    await Promise.all([
      db.setNotePerServerStatus("ce-2", CONFIG_ID, "synced"),
      db.markNotePendingForConfigs("ce-2", [OTHER_CONFIG_ID]),
    ]);
    expect(await db.getNotePerServerStatus("ce-2")).toEqual({ [CONFIG_ID]: "synced", [OTHER_CONFIG_ID]: "pending" });
  });

  it("marks a link deleted when its task is gone, drops the queue and never recreates it unasked", async () => {
    await db.addNote(makeNote({ id: "ce-3" }));
    await linkTask(db, "ce-3", 42);
    await db.markNotePendingForConfigs("ce-3", [CONFIG_ID]);
    const fetchMock = routeFetch((_url, body) => body.params.method === "write"
      ? { error: { code: 200, message: "Odoo Server Error", data: { name: "odoo.exceptions.MissingError", message: "Record does not exist" } } }
      : { result: [] });
    vi.stubGlobal("fetch", fetchMock);

    const result = await svc.syncAll(CREDS);
    expect(result.errors).toHaveLength(1);
    expect((await db.getNoteLinks("ce-3"))[0].remoteState).toBe("deleted");
    expect(await db.getNoteIdsPendingForConfig(CONFIG_ID)).toEqual([]);

    await expect(svc.pushNote(CREDS, "ce-3")).rejects.toThrow(/supprimée/);
    expect(rpcCalls(fetchMock).filter((c) => c.body.params.method === "create")).toHaveLength(0);
  });

  it("reports a deleted task as such after a re-authentication", async () => {
    await db.addNote(makeNote({ id: "ce-9" }));
    await linkTask(db, "ce-9", 42);
    let expired = true;
    vi.stubGlobal("fetch", routeFetch((url) => {
      if (url.endsWith("/web/session/authenticate")) {
        return { result: { uid: 1, session_id: "renewed", server_version_info: [18, 0] } };
      }
      if (expired) {
        expired = false;
        return { error: { code: 100, message: "Odoo Session Expired" } };
      }
      return { error: { code: 200, message: "x", data: { name: "odoo.exceptions.MissingError", message: "gone" } } };
    }));

    await expect(svc.pushNote(CREDS, "ce-9")).rejects.toBeInstanceOf(RemoteRecordDeletedError);
  });

  it("does not let a pull overwrite an edit saved during it", async () => {
    await db.addNote(makeNote({ id: "ce-10", title: "Old" }));
    await linkTask(db, "ce-10", 10);
    // The edit lands while search_read is on the wire
    vi.stubGlobal("fetch", routeFetch(() => {
      void db.updateNotePerServerStatus("ce-10", async (perServer) => {
        await db.updateNote("ce-10", makeNote({ id: "ce-10", title: "Local edit" }));
        perServer[CONFIG_ID] = "pending";
      });
      return { result: [{ id: 10, name: "Server", priority: "0", active: true, tag_ids: [], write_date: "2026-04-10 10:00:00" }] };
    }));

    await svc.pullNotes(CREDS, new Date(0));
    expect((await db.getNoteById("ce-10"))!.title).toBe("Local edit");
    expect(await db.getNotePerServerStatus("ce-10")).toEqual({ [CONFIG_ID]: "pending" });
  });

  it("reports each note a pull changed", async () => {
    await db.addNote(makeNote({ id: "ce-11", title: "Old" }));
    await linkTask(db, "ce-11", 10);
    const pulled: string[] = [];
    svc.onNotePulled = (id) => pulled.push(id);
    vi.stubGlobal("fetch", routeFetch(() => ({
      result: [{ id: 10, name: "New", priority: "0", active: true, tag_ids: [], write_date: "2026-04-10 10:00:00" }],
    })));

    await svc.pullNotes(CREDS, new Date(0));
    expect(pulled).toEqual(["ce-11"]);
  });

  it("writes no link for a note deleted while its first push ran", async () => {
    await db.addNote(makeNote({ id: "ce-12" }));
    vi.stubGlobal("fetch", routeFetch(() => {
      void db.deleteNote("ce-12");
      return { result: 99 };
    }));

    await svc.pushNote(CREDS, "ce-12");
    expect(await db.getNoteLinks("ce-12")).toEqual([]);
  });

  it("recreates a deleted task when explicitly asked", async () => {
    await db.addNote(makeNote({ id: "ce-4" }));
    await linkTask(db, "ce-4", 42);
    await db.setNoteLinkRemoteDeleted(`link-ce-4-${CONFIG_ID}`);
    vi.stubGlobal("fetch", routeFetch(() => ({ result: 43 })));

    await svc.pushNote(CREDS, "ce-4", { recreateDeleted: true });
    const live = (await db.getNoteLinks("ce-4")).filter((l) => l.remoteState === "ok");
    expect(live.map((l) => l.resId)).toEqual([43]);
  });

  it("queues the note's other servers when a pull changes it", async () => {
    await db.addNote(makeNote({ id: "ce-5", title: "Old" }));
    await linkTask(db, "ce-5", 10);
    await linkTask(db, "ce-5", 70, OTHER_CONFIG_ID);
    vi.stubGlobal("fetch", routeFetch(() => ({
      result: [{ id: 10, name: "Renamed", priority: "0", active: true, tag_ids: [], write_date: "2026-04-10 10:00:00" }],
    })));

    await svc.pullNotes(CREDS, new Date(0));
    expect(await db.getNotePerServerStatus("ce-5")).toEqual({ [CONFIG_ID]: "synced", [OTHER_CONFIG_ID]: "pending" });
  });

  it("does not count a re-read unchanged task as a change", async () => {
    await db.addNote(makeNote({ id: "ce-6", title: "Same" }));
    await linkTask(db, "ce-6", 10);
    await linkTask(db, "ce-6", 70, OTHER_CONFIG_ID);
    vi.stubGlobal("fetch", routeFetch(() => ({
      result: [{ id: 10, name: "Same", priority: "0", active: true, tag_ids: [], write_date: "2026-04-10 10:00:00" }],
    })));

    expect(await svc.pullNotes(CREDS, new Date(0))).toBe(0);
    expect(await db.getNotePerServerStatus("ce-6")).toEqual({ [CONFIG_ID]: "synced" });
  });

  it("falls back to local once the only target application is gone", async () => {
    await db.addNote(makeNote({ id: "ce-7" }));
    await db.markNotePendingForConfigs("ce-7", [OTHER_CONFIG_ID]);
    await db.deleteApplication(OTHER_CREDS.odooUrl, OTHER_CREDS.username);
    expect(await db.refreshNoteSyncStatus("ce-7")).toBe("local");
  });

  it("does not queue a link to a database its application left", async () => {
    await db.addNote(makeNote({ id: "ce-8" }));
    await linkTask(db, "ce-8", 10, OLD_DB_CONFIG_ID);
    expect(await db.getLiveLinkConfigIds("ce-8")).toEqual([]);
  });
});

describe("SyncService — pending notes", () => {
  let svc: SyncService;
  let db: DatabaseService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await prepareSyncDb(db, [CREDS, OTHER_CREDS]);
    svc = new SyncService(db);
    for (const creds of [CREDS, OTHER_CREDS]) {
      await SecureStoragePlugin.set({
        key: syncSessionKey(creds),
        value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 18 }),
      });
    }
  });

  afterEach(() => vi.unstubAllGlobals());

  const createThenEmptyPull = () => routeFetch((_url, body) =>
    body.params.method === "create" ? { result: 11 } : { result: [] });

  it("pushes a never-synced note queued offline when the network returns (no config id passed)", async () => {
    await db.addNote(makeNote({ id: "pd-1" }));
    await db.markNotePendingForConfigs("pd-1", [CONFIG_ID]);

    vi.stubGlobal("fetch", createThenEmptyPull());
    const result = await svc.syncAll(CREDS);

    expect(result.pushed).toBe(1);
    expect((await db.getNoteLinks("pd-1"))[0].resId).toBe(11);
    expect((await db.getNoteSyncInfo("pd-1")).syncStatus).toBe("synced");
  });

  it("keeps a note pending while another targeted server has not received it", async () => {
    await db.addNote(makeNote({ id: "pd-2" }));
    await db.markNotePendingForConfigs("pd-2", [CONFIG_ID, OTHER_CONFIG_ID]);

    vi.stubGlobal("fetch", createThenEmptyPull());
    await svc.syncAll(CREDS);

    expect((await db.getNoteSyncInfo("pd-2")).syncStatus).toBe("pending");
    expect(await db.getNoteIdsPendingForConfig(OTHER_CONFIG_ID)).toEqual(["pd-2"]);
    expect(await db.getNoteIdsPendingForConfig(CONFIG_ID)).toEqual([]);
  });

  it("marks only the failing server in error and leaves the note in error", async () => {
    await db.addNote(makeNote({ id: "pd-3" }));
    await db.markNotePendingForConfigs("pd-3", [CONFIG_ID]);

    vi.stubGlobal("fetch", routeFetch((_url, body) =>
      body.params.method === "create" ? { error: { code: 200, message: "boom" } } : { result: [] }));
    const result = await svc.syncAll(CREDS);

    expect(result.errors).toHaveLength(1);
    expect(await db.getNotePerServerStatus("pd-3")).toEqual({ [CONFIG_ID]: "error" });
    expect((await db.getNoteSyncInfo("pd-3")).syncStatus).toBe("error");
  });

  it("migrates a legacy global-pending note to pending on every server it targets", async () => {
    await db.addNote(makeNote({ id: "pd-4" }));
    await linkTask(db, "pd-4", 4);
    await db.setNotePerServerStatus("pd-4", CONFIG_ID, "synced");
    await db.setNoteSyncInfo("pd-4", { syncStatus: "pending", selectedSyncConfigIds: [OTHER_CONFIG_ID] });

    expect(await db.convertLegacyPendingToPerServer(await db.getLegacyPendingNoteIds())).toBe(1);
    expect(await db.getLegacyPendingNoteIds()).toEqual([]);
    expect(await db.getNotePerServerStatus("pd-4")).toEqual({ [CONFIG_ID]: "pending", [OTHER_CONFIG_ID]: "pending" });

    // Syncing the first server no longer hides the note from the second
    vi.stubGlobal("fetch", routeFetch(() => ({ result: [] })));
    await svc.syncAll(CREDS);
    expect(await db.getNoteIdsPendingForConfig(OTHER_CONFIG_ID)).toEqual(["pd-4"]);
    expect((await db.getNoteSyncInfo("pd-4")).syncStatus).toBe("pending");
  });

  it("retries a note whose creation failed once its retry delay is over, or at once when forced", async () => {
    await db.addNote(makeNote({ id: "pd-5" }));
    await db.markNotePendingForConfigs("pd-5", [CONFIG_ID]);

    vi.stubGlobal("fetch", routeFetch(() => ({ error: { code: 200, message: "502 Bad Gateway" } })));
    await svc.syncAll(CREDS);
    expect(await db.getNotePerServerStatus("pd-5")).toEqual({ [CONFIG_ID]: "error" });

    // Without force the failed creation waits out its retry delay
    vi.stubGlobal("fetch", createThenEmptyPull());
    expect((await svc.syncAll(CREDS)).pushed).toBe(0);
    vi.useFakeTimers({ toFake: ["Date"] });
    afterQuietWindow();
    const result = await svc.syncAll(CREDS, undefined, { force: true });
    vi.useRealTimers();
    expect(result.pushed).toBe(1);
    expect((await db.getNoteSyncInfo("pd-5")).syncStatus).toBe("synced");
  });

  it("leaves the other server untouched when one server fails", async () => {
    await db.addNote(makeNote({ id: "pd-6" }));
    await db.markNotePendingForConfigs("pd-6", [CONFIG_ID, OTHER_CONFIG_ID]);

    vi.stubGlobal("fetch", routeFetch(() => ({ error: { code: 200, message: "boom" } })));
    await svc.syncAll(CREDS);
    expect(await db.getNotePerServerStatus("pd-6")).toEqual({ [CONFIG_ID]: "error", [OTHER_CONFIG_ID]: "pending" });
  });

  it("ignores per-server entries of applications that no longer exist", async () => {
    await db.addNote(makeNote({ id: "pd-7" }));
    await db.markNotePendingForConfigs("pd-7", [CONFIG_ID, "https://gone.example.com|admin|mydb"]);

    vi.stubGlobal("fetch", createThenEmptyPull());
    await svc.syncAll(CREDS);
    expect((await db.getNoteSyncInfo("pd-7")).syncStatus).toBe("synced");
  });

  it("creates a never-linked note once when two pushes race", async () => {
    await db.addNote(makeNote({ id: "pd-8" }));
    const fetchMock = routeFetch(() => ({ result: 21 }));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([svc.pushNote(CREDS, "pd-8"), svc.pushNote(CREDS, "pd-8")]);

    const methods = rpcCalls(fetchMock).map((c) => c.body.params.method);
    // The second push reads the task back before writing it: no second create
    expect(methods).toEqual(["create", "search_read", "write"]);
    expect(await db.getNoteLinks("pd-8")).toHaveLength(1);
  });
});

describe("SyncService — geo_task_point probe", () => {
  let svc: SyncService;
  let db: DatabaseService;
  const GEO_NOTE = makeNote({
    id: "geo-1",
    entries: [{ id: "g", type: "geolocation", params: { text: "", latitude: 1, longitude: 2, timestamp: 0 } }],
  });

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await prepareSyncDb(db);
    svc = new SyncService(db);
    await SecureStoragePlugin.set({
      key: syncSessionKey(CREDS),
      value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 18 }),
    });
    await db.addNote(GEO_NOTE);
  });

  afterEach(() => vi.unstubAllGlobals());

  const serverWith = (fields: object) => routeFetch((_url, body) =>
    body.params.method === "fields_get" ? { result: fields } : { result: 5 });
  const createPayload = (fetchMock: ReturnType<typeof routeFetch>) =>
    rpcCalls(fetchMock).find((c) => c.body.params.method === "create")!.body.params.args![0];

  it("omits geo_task_point when the server has no such field", async () => {
    const fetchMock = serverWith({});
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "geo-1");
    expect(createPayload(fetchMock)).not.toHaveProperty("geo_task_point");
  });

  it("sends geo_task_point when the server has the field, probing once", async () => {
    const fetchMock = serverWith({ geo_task_point: { type: "geo_multi_point" } });
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "geo-1");
    await svc.pushNote(CREDS, "geo-1");
    expect(JSON.parse(createPayload(fetchMock).geo_task_point).type).toBe("MultiPoint");
    expect(rpcCalls(fetchMock).filter((c) => c.body.params.method === "fields_get")).toHaveLength(1);
  });

  it("does not probe for a note without positions", async () => {
    await db.addNote(makeNote({ id: "geo-2" }));
    const fetchMock = serverWith({});
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "geo-2");
    expect(rpcCalls(fetchMock).map((c) => c.body.params.method)).toEqual(["create"]);
  });
});

describe("SyncService — session handling", () => {
  let svc: SyncService;
  let db: DatabaseService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await prepareSyncDb(db);
    svc = new SyncService(db);
    await SecureStoragePlugin.set({
      key: syncSessionKey(CREDS),
      value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 18 }),
    });
    await db.addNote(makeNote({ id: "ss-1" }));
  });

  afterEach(() => vi.unstubAllGlobals());

  const authCalls = (fetchMock: ReturnType<typeof routeFetch>) =>
    rpcCalls(fetchMock).filter((c) => c.url.endsWith("/web/session/authenticate"));

  it("does not re-authenticate on an ordinary error whose text contains 100", async () => {
    const fetchMock = routeFetch(() => ({
      error: { code: 200, message: "Odoo Server Error", data: { message: "Value 100 exceeds the session limit" } },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(svc.pushNote(CREDS, "ss-1")).rejects.toThrow(/Value 100/);
    expect(authCalls(fetchMock)).toHaveLength(0);
  });

  it("re-authenticates once on JSON-RPC code 100 and retries", async () => {
    let expired = true;
    const fetchMock = routeFetch((url) => {
      if (url.endsWith("/web/session/authenticate")) {
        return { result: { uid: 1, session_id: "renewed", server_version_info: [18, 0] } };
      }
      if (expired) {
        expired = false;
        return { error: { code: 100, message: "Odoo Session Expired" } };
      }
      return { result: 3 };
    });
    vi.stubGlobal("fetch", fetchMock);

    await svc.pushNote(CREDS, "ss-1");
    expect(authCalls(fetchMock)).toHaveLength(1);
    expect((await db.getNoteLinks("ss-1"))[0].resId).toBe(3);
  });

  it("re-authenticates once on HTTP 401 and retries", async () => {
    let unauthorized = true;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/web/session/authenticate")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ result: { uid: 1, session_id: "renewed", server_version_info: [18, 0] } }), headers: { forEach: () => {} } };
      }
      if (unauthorized) {
        unauthorized = false;
        return { ok: false, status: 401, text: async () => "Unauthorized", headers: { forEach: () => {} } };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ result: 4 }), headers: { forEach: () => {} } };
    });
    vi.stubGlobal("fetch", fetchMock);

    await svc.pushNote(CREDS, "ss-1");
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/web/session/authenticate"))).toHaveLength(1);
    expect((await db.getNoteLinks("ss-1"))[0].resId).toBe(4);
  });

  it("keys sessions by database as well as url and user", () => {
    expect(syncSessionKey(CREDS)).not.toBe(syncSessionKey({ ...CREDS, database: "otherdb" }));
  });

  it("accepts non-Latin-1 characters in the session key", () => {
    expect(() => syncSessionKey({ ...CREDS, username: "rené@exemple.org" })).not.toThrow();
  });

  it("removes the session stored under the key that had no database", async () => {
    const legacyKey = `odoo_sync_session_${btoa(`${CREDS.odooUrl}|${CREDS.username}`)}`;
    await SecureStoragePlugin.set({ key: legacyKey, value: "{}" });
    vi.stubGlobal("fetch", routeFetch(() => ({ result: { uid: 1, session_id: "s", server_version_info: [18, 0] } })));

    await svc.authenticate(CREDS);
    expect(SecureStoragePlugin._store.has(legacyKey)).toBe(false);
  });
});

describe("DatabaseService — legacy binding backfill", () => {
  let db: DatabaseService;
  let n = 0;
  const newId = () => `bf-${++n}`;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await prepareSyncDb(db);
  });

  it("links the legacy task to the configs recorded at its url, once", async () => {
    await db.addNote(makeNote({ id: "bf-note" }));
    await db.setNoteSyncInfo("bf-note", { odooId: 42, odooUrl: CREDS.odooUrl, syncConfigId: CONFIG_ID });
    await db.setNotePerServerStatus("bf-note", OTHER_CONFIG_ID, "synced");

    expect(await db.backfillNoteLinksFromLegacyColumns(newId)).toBe(1);
    expect(await db.backfillNoteLinksFromLegacyColumns(newId)).toBe(0);

    const links = await db.getNoteLinks("bf-note");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ configId: CONFIG_ID, model: "project.task", resId: 42 });
  });

  it("falls back to the one application at that url when the note recorded no config", async () => {
    await db.addNote(makeNote({ id: "bf-orphan" }));
    await db.setNoteSyncInfo("bf-orphan", { odooId: 8, odooUrl: CREDS.odooUrl });

    await db.backfillNoteLinksFromLegacyColumns(newId);
    expect((await db.getNoteLinks("bf-orphan")).map((l) => l.configId)).toEqual([CONFIG_ID]);
  });

  it("writes no link when several applications share that url", async () => {
    await addApp(db, { ...CREDS, username: "someone", database: "otherdb" });
    await db.addNote(makeNote({ id: "bf-ambiguous" }));
    await db.setNoteSyncInfo("bf-ambiguous", { odooId: 8, odooUrl: CREDS.odooUrl });

    expect(await db.backfillNoteLinksFromLegacyColumns(newId)).toBe(0);
  });

  it("links nothing and queues the targets when the url serves several databases", async () => {
    const userB = { ...CREDS, username: "bob", database: "otherdb" };
    await addApp(db, userB);
    await db.addNote(makeNote({ id: "bf-two-db" }));
    await db.setNoteSyncInfo("bf-two-db", { odooId: 42, odooUrl: CREDS.odooUrl, syncConfigId: CONFIG_ID });
    await db.setNotePerServerStatus("bf-two-db", syncConfigIdOf(userB), "synced");

    expect(await db.backfillNoteLinksFromLegacyColumns(newId)).toBe(0);
    expect(await db.getNotePerServerStatus("bf-two-db")).toEqual({
      [CONFIG_ID]: "pending", [syncConfigIdOf(userB)]: "pending",
    });
  });

  it("gives stored url|username ids the application's database", async () => {
    await db.addNote(makeNote({ id: "bf-ids" }));
    const legacy = `${CREDS.odooUrl}|${CREDS.username}`;
    await db.setNoteSyncInfo("bf-ids", { syncConfigId: legacy, selectedSyncConfigIds: [legacy] });
    await db.setNotePerServerStatus("bf-ids", legacy, "synced");

    expect(await db.addDatabaseToLegacySyncConfigIds()).toBe(1);
    const info = await db.getNoteSyncInfo("bf-ids");
    expect([info.syncConfigId, info.selectedSyncConfigIds]).toEqual([CONFIG_ID, [CONFIG_ID]]);
    expect(await db.getNotePerServerStatus("bf-ids")).toEqual({ [CONFIG_ID]: "synced" });
  });

  it("migrates a note pushed to two users of one database, then edited, without duplicating", async () => {
    const bob = { ...CREDS, username: "bob" };
    await addApp(db, bob);
    await db.addNote(makeNote({ id: "bf-full" }));
    await db.setNoteSyncInfo("bf-full", { odooId: 42, odooUrl: CREDS.odooUrl, syncStatus: "pending" });
    await db.setNotePerServerStatus("bf-full", `${CREDS.odooUrl}|${CREDS.username}`, "synced");
    await db.setNotePerServerStatus("bf-full", `${CREDS.odooUrl}|bob`, "synced");

    await addNoteLinksTable(db);

    const links = await db.getNoteLinks("bf-full");
    expect(links.map((l) => [l.configId, l.resId]).sort()).toEqual([[CONFIG_ID, 42], [syncConfigIdOf(bob), 42]].sort());
    expect(await db.getNotePerServerStatus("bf-full")).toEqual({ [CONFIG_ID]: "pending", [syncConfigIdOf(bob)]: "pending" });
  });

  it("ignores applications without a database when judging the url's databases", async () => {
    await addApp(db, { ...CREDS, username: "viewer", database: "" });
    await db.addNote(makeNote({ id: "bf-nodb" }));
    await db.setNoteSyncInfo("bf-nodb", { odooId: 9, odooUrl: CREDS.odooUrl, syncConfigId: CONFIG_ID });

    expect(await db.backfillNoteLinksFromLegacyColumns(newId)).toBe(1);
  });

  it("matches a legacy id whose url was respelled since", async () => {
    await db.addNote(makeNote({ id: "bf-respelled" }));
    const legacy = `HTTP://odoo.example.com/|${CREDS.username}`;
    await db.setNoteSyncInfo("bf-respelled", { odooId: 5, odooUrl: "HTTP://odoo.example.com/", syncConfigId: legacy });

    await addNoteLinksTable(db);
    expect((await db.getNoteLinks("bf-respelled")).map((l) => l.configId)).toEqual([CONFIG_ID]);
  });

  it("re-keys links, selection and statuses when an application's url changes", async () => {
    const newConfig = "https://renamed.example.com|admin|mydb";
    await db.addNote(makeNote({ id: "bf-rename" }));
    await linkTask(db, "bf-rename", 3);
    await db.setNoteSyncInfo("bf-rename", { syncConfigId: CONFIG_ID, selectedSyncConfigIds: [CONFIG_ID] });
    await db.setNotePerServerStatus("bf-rename", CONFIG_ID, "synced");

    await db.renameSyncConfigId(CONFIG_ID, newConfig);

    expect((await db.getNoteLinks("bf-rename"))[0].configId).toBe(newConfig);
    const info = await db.getNoteSyncInfo("bf-rename");
    expect([info.syncConfigId, info.selectedSyncConfigIds]).toEqual([newConfig, [newConfig]]);
    expect(await db.getNotePerServerStatus("bf-rename")).toEqual({ [newConfig]: "synced" });
  });

  it("drops a note's links when the note is deleted", async () => {
    await db.addNote(makeNote({ id: "bf-del" }));
    await linkTask(db, "bf-del", 1);
    await db.deleteNote("bf-del");
    expect(await db.getNoteLinks("bf-del")).toEqual([]);
  });
});

// ─── Outbox: task creation, idempotence ───────────────────────────────────────

describe("SyncService — task creation through the outbox", () => {
  let svc: SyncService;
  let db: DatabaseService;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await prepareSyncDb(db, [CREDS, OTHER_CREDS]);
    svc = new SyncService(db);
    for (const creds of [CREDS, OTHER_CREDS]) {
      await SecureStoragePlugin.set({
        key: syncSessionKey(creds),
        value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 18 }),
      });
    }
  });

  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  /** Answers create with 50, the marker search with searchResult, the rest with []. */
  const serverWith = (searchResult: Array<{ id: number }>, failCreate = false) =>
    routeFetch((_url, body: any) => {
      const method = body.params.method;
      if (method === "create") return failCreate ? { error: { code: 200, message: "boom" } } : { result: 50 };
      if (method === "search_read" && body.params.model === "project.task"
        && JSON.stringify(body.params.kwargs.domain).includes("erplibre-mobile:")) {
        return { result: searchResult };
      }
      return { result: method === "write" ? true : [] };
    });

  it("writes the operation's marker in the new task and keeps it on the link", async () => {
    await db.addNote(makeNote({ id: "ob-1", entries: [{ id: "e", type: "text", params: { text: "hello" } } as any] }));
    const fetchMock = serverWith([]);
    vi.stubGlobal("fetch", fetchMock);

    await svc.pushNote(CREDS, "ob-1");

    const create = rpcCalls(fetchMock).find((c) => c.body.params.method === "create")!;
    const [link] = await db.getNoteLinks("ob-1");
    expect(link.clientUuid).toBeTruthy();
    expect(create.body.params.args![0].description).toContain("<p>hello</p>");
    expect(create.body.params.args![0].description).toContain(clientMarker(link.clientUuid!));
    expect(await db.getOutboxOpsForNote("ob-1")).toEqual([]);
  });

  it("does not search the marker on a first attempt", async () => {
    await db.addNote(makeNote({ id: "ob-2" }));
    const fetchMock = serverWith([]);
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "ob-2");
    expect(rpcCalls(fetchMock).map((c) => c.body.params.method)).toEqual(["create"]);
  });

  it("keeps a failed creation queued with its attempt counted and a retry delay", async () => {
    await db.addNote(makeNote({ id: "ob-3" }));
    vi.stubGlobal("fetch", serverWith([], true));
    await expect(svc.pushNote(CREDS, "ob-3")).rejects.toThrow("boom");

    const [op] = await db.getOutboxOpsForNote("ob-3");
    expect(op).toMatchObject({ kind: TASK_CREATE, configId: CONFIG_ID, status: "failed", attempts: 1 });
    expect(op.nextAttemptAt! > new Date().toISOString()).toBe(true);
    expect(await db.getNoteLinks("ob-3")).toEqual([]);
  });

  it("adopts the task an earlier attempt created instead of creating a second one", async () => {
    await db.addNote(makeNote({ id: "ob-4" }));
    vi.stubGlobal("fetch", serverWith([], true));
    await expect(svc.pushNote(CREDS, "ob-4")).rejects.toThrow();
    const [op] = await db.getOutboxOpsForNote("ob-4");
    afterQuietWindow();

    const fetchMock = serverWith([{ id: 77 }]);
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "ob-4");

    const calls = rpcCalls(fetchMock).map((c) => c.body.params as any);
    expect(calls.map((c) => c.method)).toEqual(["search_read", "write"]);
    expect(calls[0].kwargs.domain).toEqual([["description", "ilike", clientMarker(op.clientUuid)]]);
    expect(calls[0].kwargs.context).toEqual({ active_test: false });
    expect(calls[1].args[0]).toEqual([77]);
    const [link] = await db.getNoteLinks("ob-4");
    expect([link.resId, link.clientUuid]).toEqual([77, op.clientUuid]);
    expect(await db.getOutboxOpsForNote("ob-4")).toEqual([]);
    expect((await db.getNoteSyncInfo("ob-4")).syncStatus).toBe("synced");
  });

  it("creates on a retry when the marker is found nowhere", async () => {
    await db.addNote(makeNote({ id: "ob-5" }));
    vi.stubGlobal("fetch", serverWith([], true));
    await expect(svc.pushNote(CREDS, "ob-5")).rejects.toThrow();
    afterQuietWindow();

    const fetchMock = serverWith([]);
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "ob-5");
    expect(rpcCalls(fetchMock).map((c) => c.body.params.method)).toEqual(["search_read", "create"]);
    expect((await db.getNoteLinks("ob-5"))[0].resId).toBe(50);
  });

  it("blocks the creation when several tasks carry the marker, until the user retries", async () => {
    await db.addNote(makeNote({ id: "ob-6" }));
    await db.markNotePendingForConfigs("ob-6", [CONFIG_ID]);
    vi.stubGlobal("fetch", serverWith([], true));
    await svc.syncAll(CREDS);

    afterQuietWindow();
    vi.stubGlobal("fetch", serverWith([{ id: 1 }, { id: 2 }]));
    await svc.syncAll(CREDS, undefined, { force: true });
    const [op] = await db.getOutboxOpsForNote("ob-6");
    expect(op.status).toBe("blocked");
    expect(await db.getNotePerServerStatus("ob-6")).toEqual({ [CONFIG_ID]: "error" });

    // Blocked: neither an automatic sync nor a background push reaches the server
    const quiet = serverWith([{ id: 1 }, { id: 2 }]);
    vi.stubGlobal("fetch", quiet);
    await svc.syncAll(CREDS, undefined, { force: true });
    await svc.pushNote(CREDS, "ob-6");
    expect(rpcCalls(quiet).some((c) => c.body.params.method === "create" || c.body.params.method === "search_read"
      && JSON.stringify((c.body.params as any).kwargs.domain).includes("erplibre-mobile:"))).toBe(false);

    // The block keeps the candidates; a tap on sync runs the search again
    const [waiting] = await db.getOutboxOpsForNote("ob-6");
    expect([waiting.status, waiting.params.blockedReason, waiting.params.candidates]).toEqual(["blocked", "ambiguous", [1, 2]]);
    const fetchMock = serverWith([{ id: 9 }]);
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "ob-6", { userInitiated: true });
    expect((await db.getNoteLinks("ob-6"))[0].resId).toBe(9);
    expect(await db.getOutboxOpsForNote("ob-6")).toEqual([]);
  });

  it("links the task the user picked among ambiguous matches, without searching again", async () => {
    await db.addNote(makeNote({ id: "ob-6b" }));
    vi.stubGlobal("fetch", serverWith([], true));
    await expect(svc.pushNote(CREDS, "ob-6b")).rejects.toThrow();
    afterQuietWindow();
    vi.stubGlobal("fetch", serverWith([{ id: 1 }, { id: 2 }]));
    await expect(svc.pushNote(CREDS, "ob-6b")).rejects.toBeInstanceOf(OutboxBlockedError);

    const fetchMock = serverWith([{ id: 1 }, { id: 2 }]);
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "ob-6b", { userInitiated: true, adoptTaskId: 2 });

    const calls = rpcCalls(fetchMock).map((c) => c.body.params as any);
    expect(calls.map((c) => c.method)).toEqual(["write"]);
    expect(calls[0].args[0]).toEqual([2]);
    expect((await db.getNoteLinks("ob-6b"))[0].resId).toBe(2);
    expect(await db.getOutboxOpsForNote("ob-6b")).toEqual([]);
  });

  it("keeps the marker of a linked task on every write", async () => {
    await db.addNote(makeNote({ id: "ob-7" }));
    vi.stubGlobal("fetch", serverWith([]));
    await svc.pushNote(CREDS, "ob-7");
    const [link] = await db.getNoteLinks("ob-7");

    await db.updateNote("ob-7", makeNote({ id: "ob-7", entries: [{ id: "e", type: "text", params: { text: "More", readonly: false } } as any] }));
    const fetchMock = serverWith([]);
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "ob-7");
    const write = rpcCalls(fetchMock).find((c) => c.body.params.method === "write")!;
    expect(write.body.params.args![1].description).toContain(clientMarker(link.clientUuid!));
  });

  it("writes no marker on a task linked before markers existed", async () => {
    await db.addNote(makeNote({ id: "ob-8" }));
    await linkTask(db, "ob-8", 42);
    const fetchMock = serverWith([]);
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "ob-8");
    const write = rpcCalls(fetchMock).find((c) => c.body.params.method === "write")!;
    expect(write.body.params.args![1].description).not.toContain("erplibre-mobile:");
  });

  it("drops a creation row left behind once its task is linked", async () => {
    await db.addNote(makeNote({ id: "ob-9" }));
    await linkTask(db, "ob-9", 42);
    await svc.outbox.enqueue({ noteId: "ob-9", configId: CONFIG_ID, kind: TASK_CREATE });
    const fetchMock = serverWith([]);
    vi.stubGlobal("fetch", fetchMock);

    await svc.pushNote(CREDS, "ob-9");

    expect(rpcCalls(fetchMock).map((c) => c.body.params.method)).toEqual(["write"]);
    expect(await db.getOutboxOpsForNote("ob-9")).toEqual([]);
  });

  it("retries a confirmed recreation of a deleted task without asking again", async () => {
    await db.addNote(makeNote({ id: "ob-10" }));
    await linkTask(db, "ob-10", 42);
    await db.setNoteLinkRemoteDeleted("link-ob-10-" + CONFIG_ID);
    vi.stubGlobal("fetch", serverWith([], true));
    await expect(svc.pushNote(CREDS, "ob-10", { recreateDeleted: true })).rejects.toThrow("boom");
    afterQuietWindow();

    vi.stubGlobal("fetch", serverWith([]));
    await svc.pushNote(CREDS, "ob-10");
    const links = await db.getNoteLinks("ob-10");
    expect(links.find((l) => l.remoteState === "ok")!.resId).toBe(50);
  });

  it("still refuses to recreate a deleted task nobody asked for", async () => {
    await db.addNote(makeNote({ id: "ob-11" }));
    await linkTask(db, "ob-11", 42);
    await db.setNoteLinkRemoteDeleted("link-ob-11-" + CONFIG_ID);
    const fetchMock = serverWith([]);
    vi.stubGlobal("fetch", fetchMock);
    await expect(svc.pushNote(CREDS, "ob-11")).rejects.toBeInstanceOf(RemoteRecordDeletedError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.getOutboxOpsForNote("ob-11")).toEqual([]);
  });

  it("deletes a note's queued operations with the note", async () => {
    await db.addNote(makeNote({ id: "ob-12" }));
    await svc.outbox.enqueue({ noteId: "ob-12", configId: CONFIG_ID, kind: TASK_CREATE });
    await db.deleteNote("ob-12");
    expect(await db.getOutboxOpsForConfig(CONFIG_ID)).toEqual([]);
  });

  it("moves queued operations to the new id when an application url is respelled", async () => {
    await db.addNote(makeNote({ id: "ob-13" }));
    await svc.outbox.enqueue({ noteId: "ob-13", configId: CONFIG_ID, kind: TASK_CREATE });
    await db.renameSyncConfigId(CONFIG_ID, OTHER_CONFIG_ID);
    expect((await db.getOutboxOpsForNote("ob-13"))[0].configId).toBe(OTHER_CONFIG_ID);
  });

  it("runs the server's other due operations after the pending notes, once each", async () => {
    await db.addNote(makeNote({ id: "ob-14" }));
    await db.addNote(makeNote({ id: "ob-15" }));
    await db.markNotePendingForConfigs("ob-14", [CONFIG_ID]);
    const ran: string[] = [];
    svc.outbox.registerHandler("test.kind", (_c, op) => svc.outbox.attempt(op.id, async () => { ran.push(op.noteId); }));
    await svc.outbox.enqueue({ noteId: "ob-15", configId: CONFIG_ID, kind: "test.kind" });
    await svc.outbox.enqueue({ noteId: "ob-15", configId: OTHER_CONFIG_ID, kind: "test.kind" });
    const fetchMock = serverWith([]);
    vi.stubGlobal("fetch", fetchMock);

    const result = await svc.syncAll(CREDS);

    expect(ran).toEqual(["ob-15"]);
    expect(rpcCalls(fetchMock).filter((c) => c.body.params.method === "create")).toHaveLength(1);
    expect(result.pushed).toBe(2);
    expect(await db.getOutboxOpsForConfig(CONFIG_ID)).toEqual([]);
    expect(await db.getOutboxOpsForConfig(OTHER_CONFIG_ID)).toHaveLength(1);
  });

  it("tells whether a server has due work", async () => {
    await db.addNote(makeNote({ id: "ob-16" }));
    expect(await svc.hasDueWork(CONFIG_ID)).toBe(false);
    await db.markNotePendingForConfigs("ob-16", [CONFIG_ID]);
    expect(await svc.hasDueWork(CONFIG_ID)).toBe(true);

    // The creation of that note waits out its retry delay: nothing due
    vi.stubGlobal("fetch", serverWith([], true));
    await svc.syncAll(CREDS);
    expect(await svc.hasDueWork(CONFIG_ID)).toBe(false);
    expect(await svc.hasDueWork(OTHER_CONFIG_ID)).toBe(false);
  });

  it("does not search nor create again within the quiet window after a failed create, even forced or tapped", async () => {
    await db.addNote(makeNote({ id: "ob-18" }));
    await db.markNotePendingForConfigs("ob-18", [CONFIG_ID]);
    vi.stubGlobal("fetch", serverWith([], true));
    await expect(svc.pushNote(CREDS, "ob-18")).rejects.toThrow("boom");

    vi.setSystemTime(Date.now() + 60 * 1000);
    const quiet = serverWith([]);
    vi.stubGlobal("fetch", quiet);
    await svc.syncAll(CREDS, undefined, { force: true });
    await expect(svc.pushNote(CREDS, "ob-18", { userInitiated: true })).rejects.toThrow("peut encore être en cours");
    expect(rpcCalls(quiet).filter((c) => c.body.params.method !== "search_read" || (c.body.params as any).model !== "project.task")
      .map((c) => c.body.params.method)).not.toContain("create");
    expect(rpcCalls(quiet).some((c) => JSON.stringify((c.body.params as any).kwargs?.domain ?? []).includes("erplibre-mobile:"))).toBe(false);
    const [op] = await db.getOutboxOpsForNote("ob-18");
    expect(op.attempts).toBe(1);

    afterQuietWindow();
    const later = serverWith([]);
    vi.stubGlobal("fetch", later);
    await svc.pushNote(CREDS, "ob-18", { userInitiated: true });
    expect(rpcCalls(later).map((c) => c.body.params.method)).toEqual(["search_read", "create"]);
  });

  it("restarts the quiet window from now when the clock was set back after a create", async () => {
    await db.addNote(makeNote({ id: "ob-19" }));
    vi.setSystemTime(Date.now() + 2 * 3600 * 1000);
    vi.stubGlobal("fetch", serverWith([], true));
    await expect(svc.pushNote(CREDS, "ob-19")).rejects.toThrow("boom");

    vi.setSystemTime(Date.now() - 2 * 3600 * 1000);
    await expect(svc.pushNote(CREDS, "ob-19", { userInitiated: true })).rejects.toThrow("peut encore être en cours");
    afterQuietWindow();
    const fetchMock = serverWith([]);
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "ob-19", { userInitiated: true });
    expect(rpcCalls(fetchMock).map((c) => c.body.params.method)).toEqual(["search_read", "create"]);
  });

  it("creates once when a reconnect and a resume sync the same server together", async () => {
    await db.addNote(makeNote({ id: "ob-17" }));
    await db.markNotePendingForConfigs("ob-17", [CONFIG_ID]);
    const fetchMock = serverWith([]);
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([svc.syncAll(CREDS, undefined, { force: true }), svc.syncAll(CREDS)]);

    expect(rpcCalls(fetchMock).filter((c) => c.body.params.method === "create")).toHaveLength(1);
    expect(await db.getNoteLinks("ob-17")).toHaveLength(1);
  });
});

// ─── Task project ─────────────────────────────────────────────────────────────

describe("SyncService — task project", () => {
  let svc: SyncService;
  let db: DatabaseService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await prepareSyncDb(db);
    svc = new SyncService(db);
    await SecureStoragePlugin.set({
      key: syncSessionKey(CREDS),
      value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 18 }),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  /** Server with projects 7 and 8; create answers 900. */
  function server(options: { createError?: string; projectsError?: string } = {}) {
    return routeFetch((_url, body) => {
      const { model, method } = body.params as any;
      if (model === "project.project" && method === "search_read") {
        if (options.projectsError) {
          return { error: { code: 200, message: "Odoo Server Error", data: { name: options.projectsError, message: "denied" } } };
        }
        const domain = (body.params as any).kwargs.domain;
        const known = [7, 8];
        return { result: known.filter((id) => domain[0][2] === id).map((id) => ({ id })) };
      }
      if (method === "create" && options.createError) {
        return { error: { code: 200, message: "Odoo Server Error", data: { name: options.createError, message: "nope" } } };
      }
      if (method === "create") return { result: 900 };
      return { result: [] };
    });
  }

  const sent = (fetchMock: ReturnType<typeof routeFetch>, method: string) =>
    rpcCalls(fetchMock).filter((c) => c.body.params.model === "project.task" && c.body.params.method === method);

  it("creates the task in the chosen project and remembers it for the server", async () => {
    await db.addNote(makeNote({ id: "tp-1" }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);

    await svc.setTaskTarget("tp-1", CONFIG_ID, { projectId: 7, projectName: "Chantier" });
    await svc.pushNote(CREDS, "tp-1", { userInitiated: true });

    expect(sent(fetchMock, "create")[0].body.params.args![0].project_id).toBe(7);
    expect((await db.findNoteLink("tp-1", CONFIG_ID, "project.task", "create"))!.resId).toBe(900);
    expect(await svc.lastTaskTarget(CONFIG_ID)).toEqual({ projectId: 7, projectName: "Chantier" });
  });

  it("never sends project_id on a write: a task moved on the server stays in its project", async () => {
    await db.addNote(makeNote({ id: "tp-2" }));
    await linkTask(db, "tp-2", 55);
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);

    await svc.pushNote(CREDS, "tp-2");

    const write = sent(fetchMock, "write")[0].body.params.args!;
    expect(write[0]).toEqual([55]);
    expect(write[1]).not.toHaveProperty("project_id");
  });

  it("creates a personal task when no project was chosen, else the server's last project", async () => {
    await db.addNote(makeNote({ id: "tp-3" }));
    await db.addNote(makeNote({ id: "tp-4" }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);

    await svc.pushNote(CREDS, "tp-3");
    expect(sent(fetchMock, "create")[0].body.params.args![0].project_id).toBe(false);

    await db.setSyncTargetPref({ configId: CONFIG_ID, kind: TASK_CREATE, params: { projectId: 8, projectName: "B" }, updatedAt: "" });
    await svc.pushNote(CREDS, "tp-4");
    expect(sent(fetchMock, "create")[1].body.params.args![0].project_id).toBe(8);
  });

  it("blocks a creation whose project is gone, sends no create, and asks for a project again", async () => {
    await db.addNote(makeNote({ id: "tp-5" }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);

    await svc.setTaskTarget("tp-5", CONFIG_ID, { projectId: 99, projectName: "Gone" });
    const err = await svc.pushNote(CREDS, "tp-5", { userInitiated: true }).catch((e) => e);
    expect(err).toBeInstanceOf(OutboxBlockedError);
    expect(err.reason).toBe("project_missing");
    expect(sent(fetchMock, "create")).toHaveLength(0);

    const state = await svc.taskTargetState("tp-5", CONFIG_ID);
    expect(state).toMatchObject({ state: "choose", reason: "project_missing", target: { projectId: 99 } });
    // Not run again by a sync: it waits for the user
    await svc.syncAll(CREDS);
    expect(sent(fetchMock, "create")).toHaveLength(0);

    await svc.setTaskTarget("tp-5", CONFIG_ID, { projectId: 7, projectName: "A" });
    expect((await svc.taskTargetState("tp-5", CONFIG_ID)).state).toBe("queued");
    await svc.pushNote(CREDS, "tp-5", { userInitiated: true });
    expect(sent(fetchMock, "create")[0].body.params.args![0].project_id).toBe(7);
  });

  it("takes a project the user cannot read for a missing one", async () => {
    await db.addNote(makeNote({ id: "tp-6" }));
    const fetchMock = server({ projectsError: "odoo.exceptions.AccessError" });
    vi.stubGlobal("fetch", fetchMock);

    await svc.setTaskTarget("tp-6", CONFIG_ID, { projectId: 7 });
    const err = await svc.pushNote(CREDS, "tp-6", { userInitiated: true }).catch((e) => e);
    expect(err.reason).toBe("project_missing");
  });

  it("blocks a create the server refuses instead of retrying it", async () => {
    await db.addNote(makeNote({ id: "tp-7" }));
    const fetchMock = server({ createError: "odoo.exceptions.AccessError" });
    vi.stubGlobal("fetch", fetchMock);

    await svc.setTaskTarget("tp-7", CONFIG_ID, { projectId: 7 });
    const err = await svc.pushNote(CREDS, "tp-7", { userInitiated: true }).catch((e) => e);
    expect(err).toBeInstanceOf(OutboxBlockedError);
    expect(err.reason).toBe("refused");
    expect(await svc.taskTargetState("tp-7", CONFIG_ID)).toMatchObject({ state: "choose", reason: "refused" });
    expect(await svc.hasDueWork(CONFIG_ID)).toBe(false);
  });

  it("keeps a creation left to choose later off the server, even on a tap", async () => {
    await db.addNote(makeNote({ id: "tp-8" }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);

    const op = await svc.setTaskTarget("tp-8", CONFIG_ID, "later");
    expect(op!.status).toBe("incomplete");
    expect(await svc.lastTaskTarget(CONFIG_ID)).toBeNull();
    await db.markNotePendingForConfigs("tp-8", [CONFIG_ID]);

    const err = await svc.pushNote(CREDS, "tp-8", { userInitiated: true }).catch((e) => e);
    expect(err).toBeInstanceOf(OutboxBlockedError);
    expect(err.reason).toBe("incomplete");
    await svc.syncAll(CREDS, undefined, { force: true });
    expect(sent(fetchMock, "create")).toHaveLength(0);
    expect(await svc.taskTargetState("tp-8", CONFIG_ID)).toMatchObject({ state: "choose", reason: "incomplete" });

    await svc.setTaskTarget("tp-8", CONFIG_ID, { projectId: null });
    await svc.syncAll(CREDS);
    expect(sent(fetchMock, "create")).toHaveLength(1);
  });

  it("reports linked and queued notes, and leaves them alone", async () => {
    await db.addNote(makeNote({ id: "tp-9" }));
    await linkTask(db, "tp-9", 12);
    expect(await svc.taskTargetState("tp-9", CONFIG_ID)).toEqual({ state: "linked", resId: 12 });
    expect(await svc.setTaskTarget("tp-9", CONFIG_ID, { projectId: 7 })).toBeNull();

    await db.addNote(makeNote({ id: "tp-10" }));
    await svc.outbox.enqueue({ noteId: "tp-10", configId: CONFIG_ID, kind: TASK_CREATE, params: { projectId: 7 } });
    expect((await svc.taskTargetState("tp-10", CONFIG_ID)).state).toBe("queued");
    expect(await svc.setTaskTarget("tp-10", CONFIG_ID, { projectId: 8 })).toBeNull();
  });

  it("recreates a task deleted on the server in the project chosen for it", async () => {
    await db.addNote(makeNote({ id: "tp-12" }));
    await linkTask(db, "tp-12", 12);
    const link = await db.findNoteLink("tp-12", CONFIG_ID, "project.task", "create");
    await db.setNoteLinkRemoteDeleted(link!.id);
    await db.setSyncTargetPref({ configId: CONFIG_ID, kind: TASK_CREATE, params: { projectId: 8, projectName: "B" }, updatedAt: "" });
    expect(await svc.taskTargetState("tp-12", CONFIG_ID)).toMatchObject({
      state: "choose", reason: "deleted", deletedResId: 12, target: { projectId: 8 },
    });
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);

    await svc.setTaskTarget("tp-12", CONFIG_ID, { projectId: 7, projectName: "A" });
    await svc.pushNote(CREDS, "tp-12", { userInitiated: true });

    expect(sent(fetchMock, "create")[0].body.params.args![0].project_id).toBe(7);
    expect((await db.findNoteLink("tp-12", CONFIG_ID, "project.task", "create"))!.resId).toBe(900);
  });

  it("names the task deleted last when a recreated task is deleted again", async () => {
    await db.addNote(makeNote({ id: "tp-17" }));
    for (const [id, resId, createdAt] of [["l-old", 10, "2026-01-01T00:00:00.000Z"], ["l-new", 11, "2026-02-01T00:00:00.000Z"]] as const) {
      await db.addNoteLink({
        id, noteId: "tp-17", configId: CONFIG_ID, model: "project.task", resId, kind: "create",
        remoteState: "deleted", createdAt, lastSyncedAt: createdAt,
      });
    }
    expect(await svc.taskTargetState("tp-17", CONFIG_ID)).toMatchObject({ reason: "deleted", deletedResId: 11 });
  });

  it("creates at once in the project chosen again after a refused create", async () => {
    await db.addNote(makeNote({ id: "tp-13" }));
    vi.stubGlobal("fetch", server({ createError: "odoo.exceptions.ValidationError" }));
    await svc.setTaskTarget("tp-13", CONFIG_ID, { projectId: 7 });
    await svc.pushNote(CREDS, "tp-13", { userInitiated: true }).catch(() => {});

    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.setTaskTarget("tp-13", CONFIG_ID, { projectId: 8 });
    await svc.pushNote(CREDS, "tp-13", { userInitiated: true });
    expect(sent(fetchMock, "create")[0].body.params.args![0].project_id).toBe(8);
  });

  it("checks the project among the active ones and forgets it as the server's last choice when gone", async () => {
    await db.addNote(makeNote({ id: "tp-14" }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.setTaskTarget("tp-14", CONFIG_ID, { projectId: 99, projectName: "Gone" });
    await svc.pushNote(CREDS, "tp-14", { userInitiated: true }).catch(() => {});

    const check = rpcCalls(fetchMock).find((c) => c.body.params.model === "project.project")!;
    expect((check.body.params as any).kwargs.context).toBeUndefined();
    expect(await svc.lastTaskTarget(CONFIG_ID)).toEqual({ projectId: null, projectName: null });
  });

  it("parks a refused creation left for later without its old reason, then waits for a project", async () => {
    await db.addNote(makeNote({ id: "tp-15" }));
    vi.stubGlobal("fetch", server({ createError: "odoo.exceptions.AccessError" }));
    await svc.setTaskTarget("tp-15", CONFIG_ID, { projectId: 7 });
    await svc.pushNote(CREDS, "tp-15", { userInitiated: true }).catch(() => {});

    const op = await svc.setTaskTarget("tp-15", CONFIG_ID, "later");
    expect(op).toMatchObject({ status: "incomplete", lastError: null, params: { blockedReason: null, projectId: 7 } });
    const err = await svc.pushNote(CREDS, "tp-15", { userInitiated: true }).catch((e) => e);
    expect(err.reason).toBe("incomplete");
  });

  it("drops a missing project from a creation left for later", async () => {
    await db.addNote(makeNote({ id: "tp-16" }));
    vi.stubGlobal("fetch", server());
    await svc.setTaskTarget("tp-16", CONFIG_ID, { projectId: 99 });
    await svc.pushNote(CREDS, "tp-16", { userInitiated: true }).catch(() => {});

    await svc.setTaskTarget("tp-16", CONFIG_ID, "later");
    expect(await svc.taskTargetState("tp-16", CONFIG_ID)).toMatchObject({
      state: "choose", reason: "incomplete", target: { projectId: null },
    });
  });

  it("offers the server's last project to a note never pushed there", async () => {
    await db.addNote(makeNote({ id: "tp-11" }));
    expect(await svc.taskTargetState("tp-11", CONFIG_ID)).toEqual({ state: "choose", op: null, reason: null, target: null });
    await db.setSyncTargetPref({ configId: CONFIG_ID, kind: TASK_CREATE, params: { projectId: 8, projectName: "B" }, updatedAt: "" });
    expect(await svc.taskTargetState("tp-11", CONFIG_ID)).toMatchObject({ state: "choose", target: { projectId: 8, projectName: "B" } });
  });
});

// ─── Opportunity ──────────────────────────────────────────────────────────────

describe("SyncService — opportunity", () => {
  let svc: SyncService;
  let db: DatabaseService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await prepareSyncDb(db);
    svc = new SyncService(db);
    await SecureStoragePlugin.set({
      key: syncSessionKey(CREDS),
      value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 17 }),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  /** Server with partner 5; creates answer 700 (lead) and 900 (task); tags exist. */
  function server(options: { leadCreateError?: string; markerHits?: number[] } = {}) {
    return routeFetch((_url, body) => {
      const { model, method } = body.params as any;
      const kwargs = (body.params as any).kwargs ?? {};
      if (model === "res.partner" && method === "search_read") {
        return { result: kwargs.domain[0][2] === 5 ? [{ id: 5 }] : [] };
      }
      if (method === "search_read" && kwargs.domain?.[0]?.[0] === "description") {
        return { result: (options.markerHits ?? []).map((id) => ({ id })) };
      }
      if ((model === "crm.tag" || model === "project.tags") && method === "search_read") {
        return { result: [{ id: 31, name: "urgent" }] };
      }
      if (model === "crm.lead" && method === "create") {
        if (options.leadCreateError) {
          return { error: { code: 200, message: "Odoo Server Error", data: { name: options.leadCreateError, message: "nope" } } };
        }
        return { result: 700 };
      }
      if (method === "create") return { result: 900 };
      return { result: method === "search_read" ? [] : true };
    });
  }

  const sent = (fetchMock: ReturnType<typeof routeFetch>, model: string, method: string) =>
    rpcCalls(fetchMock).filter((c) => c.body.params.model === model && c.body.params.method === method);

  it("creates an opportunity with its client, revenue, crm tags and the day of its first date", async () => {
    await db.addNote(makeNote({
      id: "ld-1", title: "Lead", tags: ["urgent"],
      entries: [{ id: "e1", type: "date", params: { date: "2026-11-05T14:30:00.000Z" } } as any],
    }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);

    await svc.setTarget("ld-1", CONFIG_ID, "lead", { partnerId: 5, partnerName: "Acme", expectedRevenue: 1500 });
    await svc.pushNote(CREDS, "ld-1", { userInitiated: true });

    const values = sent(fetchMock, "crm.lead", "create")[0].body.params.args![0];
    expect(values).toMatchObject({
      name: "Lead", type: "opportunity", partner_id: 5, expected_revenue: 1500,
      tag_ids: [[6, 0, [31]]], date_deadline: "2026-11-05", active: true,
    });
    expect(values.description).toContain("erplibre-mobile:");
    expect(values).not.toHaveProperty("project_id");
    expect(values).not.toHaveProperty("state");
    expect(sent(fetchMock, "project.task", "create")).toHaveLength(0);
    expect((await db.findNoteLink("ld-1", CONFIG_ID, "crm.lead", "create"))!.resId).toBe(700);
  });

  it("writes a linked opportunity without type, client or revenue", async () => {
    await db.addNote(makeNote({ id: "ld-2", title: "B" }));
    await db.addNoteLink({
      id: "lk-2", noteId: "ld-2", configId: CONFIG_ID, model: "crm.lead", resId: 70, kind: "create",
      remoteState: "ok", createdAt: "2026-01-01T00:00:00.000Z", lastSyncedAt: "2026-01-01T00:00:00.000Z",
    });
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);

    await svc.pushNote(CREDS, "ld-2");

    const [ids, values] = sent(fetchMock, "crm.lead", "write")[0].body.params.args!;
    expect(ids).toEqual([70]);
    expect(values).toMatchObject({ name: "B" });
    for (const key of ["type", "partner_id", "expected_revenue", "project_id"]) expect(values).not.toHaveProperty(key);
    expect(sent(fetchMock, "project.task", "create")).toHaveLength(0);
  });

  it("pushes a task and an opportunity of one note to the same server", async () => {
    await db.addNote(makeNote({ id: "ld-3" }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);

    await svc.setTarget("ld-3", CONFIG_ID, "task", { projectId: null });
    await svc.setTarget("ld-3", CONFIG_ID, "lead", { partnerId: null });
    expect(await svc.noteKinds("ld-3", CONFIG_ID)).toEqual(["task", "lead"]);
    await svc.pushNote(CREDS, "ld-3", { userInitiated: true });

    expect(sent(fetchMock, "project.task", "create")).toHaveLength(1);
    expect(sent(fetchMock, "crm.lead", "create")[0].body.params.args![0]).not.toHaveProperty("partner_id");
    expect((await db.getNoteSyncInfo("ld-3")).syncStatus).toBe("synced");
  });

  it("blocks an opportunity whose client is gone, without creating it", async () => {
    await db.addNote(makeNote({ id: "ld-4" }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);

    await svc.setTarget("ld-4", CONFIG_ID, "lead", { partnerId: 99 });
    const err = await svc.pushNote(CREDS, "ld-4", { userInitiated: true }).catch((e) => e);
    expect(err).toBeInstanceOf(OutboxBlockedError);
    expect(err).toMatchObject({ reason: "partner_missing", opKind: LEAD_CREATE });
    expect(sent(fetchMock, "crm.lead", "create")).toHaveLength(0);
    expect(await svc.targetState("ld-4", CONFIG_ID, "lead")).toMatchObject({ state: "choose", reason: "partner_missing" });
  });

  it("adopts the opportunity a lost create made, found by its marker", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await db.addNote(makeNote({ id: "ld-5" }));
    // The create is sent, its answer lost
    vi.stubGlobal("fetch", routeFetch((_url, body) => {
      if ((body.params as any).method === "create") throw new TypeError("Failed to fetch");
      return { result: [] };
    }));
    await svc.setTarget("ld-5", CONFIG_ID, "lead", { partnerId: null });
    await svc.pushNote(CREDS, "ld-5", { userInitiated: true }).catch(() => {});

    afterQuietWindow();
    const fetchMock = server({ markerHits: [701] });
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "ld-5", { userInitiated: true });
    vi.useRealTimers();

    expect(sent(fetchMock, "crm.lead", "create")).toHaveLength(0);
    expect(sent(fetchMock, "crm.lead", "write")[0].body.params.args![0]).toEqual([701]);
    expect((await db.findNoteLink("ld-5", CONFIG_ID, "crm.lead", "create"))!.resId).toBe(701);
  });

  it("does not remember a client as the server's next choice", async () => {
    await db.addNote(makeNote({ id: "ld-6" }));
    await svc.setTarget("ld-6", CONFIG_ID, "lead", { partnerId: 5, partnerName: "Acme" });
    expect(await svc.lastTarget(CONFIG_ID, "lead")).toBeNull();
    await db.addNote(makeNote({ id: "ld-7" }));
    expect(await svc.targetState("ld-7", CONFIG_ID, "lead")).toMatchObject({ state: "choose", target: null });
  });

  async function linkLead(noteId: string, resId: number, state: "ok" | "deleted" = "ok") {
    await db.addNoteLink({
      id: `lead-${noteId}`, noteId, configId: CONFIG_ID, model: "crm.lead", resId, kind: "create",
      remoteState: state, createdAt: "2026-01-01T00:00:00.000Z", lastSyncedAt: "2026-01-01T00:00:00.000Z",
    });
  }

  it("keeps writing a linked task while the note's opportunity waits for a choice", async () => {
    await db.addNote(makeNote({ id: "ld-10" }));
    await linkTask(db, "ld-10", 10);
    await svc.setTarget("ld-10", CONFIG_ID, "lead", "later");
    await db.markNotePendingForConfigs("ld-10", [CONFIG_ID]);
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);

    expect(await svc.hasDueWork(CONFIG_ID)).toBe(true);
    const result = await svc.syncAll(CREDS);

    expect(sent(fetchMock, "project.task", "write")[0].body.params.args![0]).toEqual([10]);
    expect(sent(fetchMock, "crm.lead", "create")).toHaveLength(0);
    expect(result.errors).toEqual([]);
    expect(await db.getNotePerServerStatus("ld-10")).toEqual({ [CONFIG_ID]: "synced" });
  });

  it("has no due work for a note whose only kind waits for the user", async () => {
    await db.addNote(makeNote({ id: "ld-11" }));
    await svc.setTarget("ld-11", CONFIG_ID, "lead", "later");
    await db.markNotePendingForConfigs("ld-11", [CONFIG_ID]);
    expect(await svc.hasDueWork(CONFIG_ID)).toBe(false);
  });

  it("stays pending when the note changes while one of its kinds is written", async () => {
    await db.addNote(makeNote({ id: "ld-12", title: "A" }));
    await linkTask(db, "ld-12", 10);
    await linkLead("ld-12", 70);
    vi.stubGlobal("fetch", routeFetch((_url, body) => {
      if ((body.params as any).model === "project.task" && (body.params as any).method === "write") {
        void db.updateNote("ld-12", makeNote({ id: "ld-12", title: "B" }));
      }
      return { result: (body.params as any).method === "search_read" ? [] : true };
    }));
    await svc.pushNote(CREDS, "ld-12");
    await new Promise((r) => setTimeout(r, 0));
    expect(await db.getNotePerServerStatus("ld-12")).toEqual({ [CONFIG_ID]: "pending" });
  });

  it("leaves a deleted opportunity alone in background next to a live task, and keeps the status", async () => {
    await db.addNote(makeNote({ id: "ld-13" }));
    await linkTask(db, "ld-13", 10);
    await linkLead("ld-13", 70, "deleted");
    await db.markNotePendingForConfigs("ld-13", [CONFIG_ID]);
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);

    const result = await svc.syncAll(CREDS);
    expect(result.errors).toEqual([]);
    expect(sent(fetchMock, "project.task", "write")).toHaveLength(1);
    expect(await db.getNotePerServerStatus("ld-13")).toEqual({ [CONFIG_ID]: "synced" });

    // A tap still reports it, without taking the server out of the queue
    await expect(svc.pushNote(CREDS, "ld-13", { userInitiated: true })).rejects.toBeInstanceOf(RemoteRecordDeletedError);
    expect(await db.getNotePerServerStatus("ld-13")).toEqual({ [CONFIG_ID]: "synced" });
  });

  it("stops asking about a kind the user dropped", async () => {
    await db.addNote(makeNote({ id: "ld-14" }));
    await linkTask(db, "ld-14", 10);
    await linkLead("ld-14", 70, "deleted");
    expect(await svc.targetState("ld-14", CONFIG_ID, "lead")).toMatchObject({ reason: "deleted" });

    await svc.dropTarget("ld-14", CONFIG_ID, "lead");

    expect(await svc.noteKinds("ld-14", CONFIG_ID)).toEqual(["task"]);
    expect(await svc.targetState("ld-14", CONFIG_ID, "lead")).toMatchObject({ state: "choose", op: null, reason: null });
    expect((await db.getNoteLinks("ld-14")).find((l) => l.model === "crm.lead")!.remoteState).toBe("dismissed");
  });

  it("cancels a waiting creation the user dropped", async () => {
    await db.addNote(makeNote({ id: "ld-16" }));
    await svc.setTarget("ld-16", CONFIG_ID, "lead", "later");
    await svc.dropTarget("ld-16", CONFIG_ID, "lead");
    expect(await db.getOutboxOpsForNote("ld-16")).toEqual([]);
  });

  it("queues the opportunity when a pull changes a note that also has a task there", async () => {
    await db.addNote(makeNote({ id: "ld-17", title: "Old" }));
    await linkTask(db, "ld-17", 10);
    await linkLead("ld-17", 70);
    vi.stubGlobal("fetch", routeFetch(() => ({
      result: [{ id: 10, name: "New", priority: "0", active: true, tag_ids: [], date_deadline: false,
        write_date: "2026-05-01 08:00:00", state: "01_in_progress" }],
    })));
    await svc.pullNotes(CREDS, new Date(0));
    expect((await db.getNoteById("ld-17"))!.title).toBe("New");
    expect(await db.getNotePerServerStatus("ld-17")).toEqual({ [CONFIG_ID]: "pending" });
  });

  it("sends active on create only, and date_deadline false for a note without a date", async () => {
    await db.addNote(makeNote({ id: "ld-18", archived: false }));
    await linkLead("ld-18", 70);
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "ld-18");
    const values = sent(fetchMock, "crm.lead", "write")[0].body.params.args![1];
    expect(values).not.toHaveProperty("active");
    // false clears a date removed in the app
    expect(values.date_deadline).toBe(false);
  });

  it("takes the device's local day for the opportunity's date", async () => {
    const local = new Date(2026, 10, 5, 23, 30);
    await db.addNote(makeNote({ id: "ld-19", entries: [{ id: "e", type: "date", params: { date: local.toISOString() } } as any] }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.setTarget("ld-19", CONFIG_ID, "lead", { partnerId: null });
    await svc.pushNote(CREDS, "ld-19", { userInitiated: true });
    expect(sent(fetchMock, "crm.lead", "create")[0].body.params.args![0].date_deadline).toBe("2026-11-05");
  });

  it("finds or creates the opportunity's tags in crm.tag", async () => {
    await db.addNote(makeNote({ id: "ld-20", tags: ["urgent"] }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.setTarget("ld-20", CONFIG_ID, "lead", { partnerId: null });
    await svc.pushNote(CREDS, "ld-20", { userInitiated: true });
    expect(sent(fetchMock, "crm.tag", "search_read")).toHaveLength(1);
    expect(sent(fetchMock, "project.tags", "search_read")).toHaveLength(0);
  });

  it("still writes the opportunity when the task write fails, then raises the failure", async () => {
    await db.addNote(makeNote({ id: "ld-21" }));
    await linkTask(db, "ld-21", 10);
    await linkLead("ld-21", 70);
    const fetchMock = routeFetch((_url, body) => {
      if ((body.params as any).model === "project.task" && (body.params as any).method === "write") {
        return { error: { code: 200, message: "Odoo Server Error", data: { name: "odoo.exceptions.UserError", message: "locked" } } };
      }
      return { result: (body.params as any).method === "search_read" ? [] : true };
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(svc.pushNote(CREDS, "ld-21")).rejects.toThrow("locked");
    expect(sent(fetchMock, "crm.lead", "write")).toHaveLength(1);
  });

  it("runs only the operation's kind from the outbox, leaving the other kind's delay alone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // A tag: the first request (tag search) fails, before any create is sent
    await db.addNote(makeNote({ id: "ld-22", tags: ["x"] }));
    vi.stubGlobal("fetch", routeFetch(() => { throw new TypeError("Failed to fetch"); }));
    await svc.setTarget("ld-22", CONFIG_ID, "task", { projectId: null });
    await svc.pushNote(CREDS, "ld-22", { userInitiated: true }).catch(() => {});
    const taskOp = (await db.getOutboxOpsForNote("ld-22"))[0];
    expect(taskOp.status).toBe("failed");
    expect(taskOp.params.createSentAt).toBeUndefined();

    await svc.setTarget("ld-22", CONFIG_ID, "lead", { partnerId: null });
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.outbox.drain(CREDS, CONFIG_ID);
    vi.useRealTimers();

    expect(sent(fetchMock, "crm.lead", "create")).toHaveLength(1);
    expect(sent(fetchMock, "project.task", "create")).toHaveLength(0);
    expect((await db.getOutboxOp(taskOp.id))!.attempts).toBe(taskOp.attempts);
  });

  it("keeps the typed revenue when a missing client is left for later", async () => {
    await db.addNote(makeNote({ id: "ld-23" }));
    vi.stubGlobal("fetch", server());
    await svc.setTarget("ld-23", CONFIG_ID, "lead", { partnerId: 99, expectedRevenue: 1500 });
    await svc.pushNote(CREDS, "ld-23", { userInitiated: true }).catch(() => {});
    await svc.setTarget("ld-23", CONFIG_ID, "lead", "later");
    expect(await svc.targetState("ld-23", CONFIG_ID, "lead")).toMatchObject({
      reason: "incomplete", target: { partnerId: null, expectedRevenue: 1500 },
    });
  });

  it("dismisses every deleted link of a dropped kind", async () => {
    await db.addNote(makeNote({ id: "ld-30" }));
    await linkTask(db, "ld-30", 5);
    for (const [id, resId, at] of [["d1", 70, "2026-01-01T00:00:00.000Z"], ["d2", 71, "2026-02-01T00:00:00.000Z"]] as const) {
      await db.addNoteLink({ id, noteId: "ld-30", configId: CONFIG_ID, model: "crm.lead", resId, kind: "create",
        remoteState: "deleted", createdAt: at, lastSyncedAt: at });
    }
    await svc.dropTarget("ld-30", CONFIG_ID, "lead");
    expect(await svc.targetState("ld-30", CONFIG_ID, "lead")).toMatchObject({ reason: null });
    expect(await svc.noteKinds("ld-30", CONFIG_ID)).toEqual(["task"]);
  });

  it("shows a note pending while one of its creations waits, even when its other kind is synced", async () => {
    await db.addNote(makeNote({ id: "ld-31" }));
    await linkTask(db, "ld-31", 10);
    await db.setNotePerServerStatus("ld-31", CONFIG_ID, "synced");
    await svc.setTarget("ld-31", CONFIG_ID, "lead", "later");
    expect(await db.refreshNoteSyncStatus("ld-31")).toBe("pending");
    expect(await svc.hasDueWork(CONFIG_ID)).toBe(false);
  });

  it("keeps the revenue typed with a first 'later' choice", async () => {
    await db.addNote(makeNote({ id: "ld-32" }));
    await svc.setTarget("ld-32", CONFIG_ID, "lead", "later", { expectedRevenue: 800 });
    expect(await svc.targetState("ld-32", CONFIG_ID, "lead")).toMatchObject({
      reason: "incomplete", target: { expectedRevenue: 800 },
    });
  });

  it("derives statuses before the outbox table exists, as migration 2026102201 does", async () => {
    await db.addNote(makeNote({ id: "ld-40" }));
    vi.spyOn(db, "getOutboxOpsForNote").mockRejectedValue(new Error("no such table: sync_outbox"));
    await expect(addNoteLinksTable(db)).resolves.toBeDefined();
    expect(await db.refreshNoteSyncStatus("ld-40")).toBe("local");
    vi.restoreAllMocks();
  });

  it("remembers the kinds last checked per server, a task by default", async () => {
    expect(await svc.lastKinds(CONFIG_ID)).toEqual(["task"]);
    await svc.setLastKinds(CONFIG_ID, ["lead"]);
    expect(await svc.lastKinds(CONFIG_ID)).toEqual(["lead"]);
  });
});

describe("SyncService — activities", () => {
  let svc: SyncService;
  let db: DatabaseService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await prepareSyncDb(db);
    await db.addParamsToNoteLinks();
    svc = new SyncService(db);
    await SecureStoragePlugin.set({
      key: syncSessionKey(CREDS),
      value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 17 }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const ON_PARTNER = {
    resModel: "res.partner", resId: 5, resName: "Acme", typeId: 2, typeName: "Call",
    deadline: "2026-11-02", userId: 8, userName: "Lee",
  };

  /**
   * Server with partner 5, activity type 2 and user 8; activity creates
   * answer 500, 501, …, every activity from 500 exists (archived: those
   * archived); activityError makes writes and action_feedback answer that
   * exception. fields_get gives every model activities, except noActivities.
   */
  function server(options: {
    createError?: string; activityError?: string; markerHits?: number[]; archived?: number[]; noActivities?: string[];
  } = {}) {
    let next = 500;
    const known: Record<string, number> = { "res.partner": 5, "mail.activity.type": 2, "res.users": 8 };
    const fail = (name: string) => ({ error: { code: 200, message: "Odoo Server Error", data: { name, message: "nope" } } });
    return routeFetch((_url, body) => {
      const { model, method, args } = body.params as any;
      const kwargs = (body.params as any).kwargs ?? {};
      if (method === "fields_get") {
        return { result: options.noActivities?.includes(model) ? { name: {} } : { name: {}, activity_ids: {} } };
      }
      if (model === "mail.activity" && method === "search_read" && kwargs.domain?.[0]?.[0] === "id") {
        const id = kwargs.domain[0][2];
        const stored = activities.get(id) ?? {};
        // A deleted activity is not read back
        if (options.activityError === "odoo.exceptions.MissingError") return { result: [] };
        return { result: id >= 500 ? [{ id, active: !(options.archived ?? []).includes(id), ...stored }] : [] };
      }
      if (model === "mail.activity" && method === "write" && !options.activityError) {
        activities.set(args[0][0], { ...(activities.get(args[0][0]) ?? {}), ...args[1] });
      }
      if (model === "mail.activity" && method === "create" && !options.createError) {
        activities.set(next, { summary: args[0].summary, note: args[0].note, date_deadline: args[0].date_deadline ?? false });
      }
      if (method === "search_read" && kwargs.domain?.[0]?.[0] === "note") {
        return { result: (options.markerHits ?? []).map((id) => ({ id })) };
      }
      if (method === "search_read" && kwargs.domain?.[0]?.[0] === "id" && model in known) {
        return { result: kwargs.domain[0][2] === known[model] ? [{ id: known[model] }] : [] };
      }
      if (model === "mail.activity" && method === "create") {
        return options.createError ? fail(options.createError) : { result: next++ };
      }
      if (model === "mail.activity" && options.activityError) return fail(options.activityError);
      if (method === "create") return { result: 900 };
      return { result: method === "search_read" ? [] : true };
    });
  }

  /** What the fake server holds of each activity it created or wrote, by id. */
  let activities: Map<number, Record<string, any>>;
  beforeEach(() => { activities = new Map(); });

  const sent = (fetchMock: ReturnType<typeof routeFetch>, model: string, method: string) =>
    rpcCalls(fetchMock).filter((c) => c.body.params.model === model && c.body.params.method === method);

  const activityLinks = async (noteId: string) =>
    (await db.getNoteLinks(noteId)).filter((l) => l.kind === "activity");

  it("creates an activity on the chosen record, its model passed as a default, without a task", async () => {
    await db.addNote(makeNote({ id: "ac-1", title: "Call back", entries: [{ id: "e", type: "text", params: { text: "Ask for the quote", readonly: false } } as any] }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);

    await svc.setActivity("ac-1", CONFIG_ID, ON_PARTNER);
    expect(await svc.noteKinds("ac-1", CONFIG_ID)).toEqual([]);
    await svc.pushNote(CREDS, "ac-1", { userInitiated: true });

    const [create] = sent(fetchMock, "mail.activity", "create");
    const values = create.body.params.args![0];
    expect(values).toMatchObject({
      res_id: 5, activity_type_id: 2, date_deadline: "2026-11-02", user_id: 8, summary: "Call back",
    });
    expect(values.note).toContain("Ask for the quote");
    expect(values.note).toContain("erplibre-mobile:");
    expect(values).not.toHaveProperty("res_model");
    expect((create.body.params as any).kwargs.context).toEqual({ default_res_model: "res.partner" });
    expect(sent(fetchMock, "project.task", "create")).toHaveLength(0);
    const [link] = await activityLinks("ac-1");
    expect(link).toMatchObject({ model: "mail.activity", resId: 500, remoteState: "ok", params: ON_PARTNER });
    expect((await db.getNoteSyncInfo("ac-1")).syncStatus).toBe("synced");
  });

  it("leaves the server's defaults when no type, deadline or user is chosen", async () => {
    await db.addNote(makeNote({ id: "ac-2" }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.setActivity("ac-2", CONFIG_ID, { ...ON_PARTNER, typeId: null, deadline: null, userId: null });
    await svc.pushNote(CREDS, "ac-2", { userInitiated: true });
    const values = sent(fetchMock, "mail.activity", "create")[0].body.params.args![0];
    for (const key of ["activity_type_id", "user_id"]) expect(values).not.toHaveProperty(key);
    // Due today on the device, sent so the base knows the day the server holds
    expect(values.date_deadline).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("keeps several activities of one note on one server apart", async () => {
    await db.addNote(makeNote({ id: "ac-3" }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.setActivity("ac-3", CONFIG_ID, ON_PARTNER);
    await svc.setActivity("ac-3", CONFIG_ID, { ...ON_PARTNER, typeId: null });
    await svc.pushNote(CREDS, "ac-3", { userInitiated: true });
    expect((await activityLinks("ac-3")).map((l) => l.resId).sort()).toEqual([500, 501]);
    const states = await svc.activityStates("ac-3", CONFIG_ID);
    expect(states.map((s) => s.state)).toEqual(["linked", "linked"]);
  });

  it("writes the summary and note of a live activity, never its record, type, deadline or user", async () => {
    await db.addNote(makeNote({ id: "ac-4" }));
    vi.stubGlobal("fetch", server());
    await svc.setActivity("ac-4", CONFIG_ID, ON_PARTNER);
    await svc.pushNote(CREDS, "ac-4", { userInitiated: true });
    await db.updateNote("ac-4", makeNote({ id: "ac-4", title: "Renamed" }));

    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "ac-4");
    const [ids, values] = sent(fetchMock, "mail.activity", "write")[0].body.params.args!;
    expect(ids).toEqual([500]);
    // Only the title changed: only the summary is written
    expect(Object.keys(values)).toEqual(["summary"]);
    expect(values.summary).toBe("Renamed");
    expect(sent(fetchMock, "mail.activity", "create")).toHaveLength(0);
  });

  it("marks a live activity done once the note is done, then never writes it again", async () => {
    await db.addNote(makeNote({ id: "ac-5" }));
    vi.stubGlobal("fetch", server());
    await svc.setActivity("ac-5", CONFIG_ID, ON_PARTNER);
    await svc.pushNote(CREDS, "ac-5", { userInitiated: true });
    await db.updateNote("ac-5", makeNote({ id: "ac-5", done: true }));

    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "ac-5");
    expect(sent(fetchMock, "mail.activity", "action_feedback")[0].body.params.args).toEqual([[500]]);
    expect(sent(fetchMock, "mail.activity", "write")).toHaveLength(0);
    expect((await activityLinks("ac-5"))[0].remoteState).toBe("done");
    expect((await svc.activityStates("ac-5", CONFIG_ID))[0].state).toBe("done");

    const later = server();
    vi.stubGlobal("fetch", later);
    await svc.pushNote(CREDS, "ac-5", { userInitiated: true });
    expect(sent(later, "mail.activity", "action_feedback")).toHaveLength(0);
    expect(sent(later, "project.task", "create")).toHaveLength(0);
  });

  it("marks done at once an activity created for a note already done", async () => {
    await db.addNote(makeNote({ id: "ac-6", done: true }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.setActivity("ac-6", CONFIG_ID, ON_PARTNER);
    await svc.syncAll(CREDS);
    expect(sent(fetchMock, "mail.activity", "create")).toHaveLength(1);
    expect(sent(fetchMock, "mail.activity", "action_feedback")[0].body.params.args).toEqual([[500]]);
    expect((await activityLinks("ac-6"))[0].remoteState).toBe("done");
  });

  it("keeps as history an activity gone on the server, and lets the note leave that server's queue", async () => {
    await db.addNote(makeNote({ id: "ac-7" }));
    vi.stubGlobal("fetch", server());
    await svc.setActivity("ac-7", CONFIG_ID, ON_PARTNER);
    await svc.pushNote(CREDS, "ac-7", { userInitiated: true });
    await db.setNotePerServerStatus("ac-7", CONFIG_ID, "pending");

    vi.stubGlobal("fetch", server({ activityError: "odoo.exceptions.MissingError" }));
    await expect(svc.pushNote(CREDS, "ac-7", { userInitiated: true })).resolves.toBeUndefined();
    expect((await activityLinks("ac-7"))[0].remoteState).toBe("deleted");
    expect(await db.getNotePerServerStatus("ac-7")).toEqual({});
    expect(await svc.hasDueWork(CONFIG_ID)).toBe(false);
  });

  it("raises any other failure of a write", async () => {
    await db.addNote(makeNote({ id: "ac-8" }));
    vi.stubGlobal("fetch", server());
    await svc.setActivity("ac-8", CONFIG_ID, ON_PARTNER);
    await svc.pushNote(CREDS, "ac-8", { userInitiated: true });
    await db.updateNote("ac-8", makeNote({ id: "ac-8", title: "Changed" }));
    vi.stubGlobal("fetch", server({ activityError: "odoo.exceptions.AccessError" }));
    await expect(svc.pushNote(CREDS, "ac-8")).rejects.toThrow("nope");
    expect((await activityLinks("ac-8"))[0].remoteState).toBe("ok");
  });

  it("blocks, without creating it, an activity whose record, type or user is gone", async () => {
    for (const [i, [over, reason]] of ([
      [{ resId: 99 }, "record_missing"], [{ typeId: 99 }, "type_missing"], [{ userId: 99 }, "user_missing"],
    ] as const).entries()) {
      const noteId = `ac-9-${i}`;
      await db.addNote(makeNote({ id: noteId }));
      const fetchMock = server();
      vi.stubGlobal("fetch", fetchMock);
      const op = (await svc.setActivity(noteId, CONFIG_ID, { ...ON_PARTNER, ...over }))!;
      const err = await svc.pushNote(CREDS, noteId, { userInitiated: true }).catch((e) => e);
      expect(err).toBeInstanceOf(OutboxBlockedError);
      expect(err).toMatchObject({ reason, opKind: ACTIVITY_CREATE, opId: op.id });
      expect(sent(fetchMock, "mail.activity", "create")).toHaveLength(0);
      expect((await svc.activityStates(noteId, CONFIG_ID))[0]).toMatchObject({ state: "choose", reason });
    }
  });

  it("checks the record archived ones included, as a done task's note is archived", async () => {
    await db.addNote(makeNote({ id: "ac-10" }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.setActivity("ac-10", CONFIG_ID, ON_PARTNER);
    await svc.pushNote(CREDS, "ac-10", { userInitiated: true });
    const check = sent(fetchMock, "res.partner", "search_read")[0];
    expect((check.body.params as any).kwargs.context).toEqual({ active_test: false });
    const typeCheck = sent(fetchMock, "mail.activity.type", "search_read")[0];
    expect((typeCheck.body.params as any).kwargs).not.toHaveProperty("context");
  });

  it("blocks an activity on a model the server does not have", async () => {
    await db.addNote(makeNote({ id: "ac-11" }));
    vi.stubGlobal("fetch", routeFetch((_url, body) => {
      const { model } = body.params as any;
      if (model === "x.gone") return { error: { code: 200, message: "Odoo Server Error", data: { name: "builtins.KeyError", message: "x.gone" } } };
      return { result: [] };
    }));
    await svc.setActivity("ac-11", CONFIG_ID, { ...ON_PARTNER, resModel: "x.gone", typeId: null, userId: null });
    const err = await svc.pushNote(CREDS, "ac-11", { userInitiated: true }).catch((e) => e);
    expect(err).toMatchObject({ reason: "model_unusable" });
    expect((await svc.activityStates("ac-11", CONFIG_ID))[0]).toMatchObject({ state: "choose", reason: "model_unusable" });
  });

  it("blocks, without creating it, an activity on a model that takes none", async () => {
    await db.addNote(makeNote({ id: "ac-23" }));
    const fetchMock = server({ noActivities: ["res.country"] });
    vi.stubGlobal("fetch", fetchMock);
    await svc.setActivity("ac-23", CONFIG_ID, { ...ON_PARTNER, resModel: "res.country" });
    const err = await svc.pushNote(CREDS, "ac-23", { userInitiated: true }).catch((e) => e);
    expect(err).toMatchObject({ reason: "model_unusable", opKind: ACTIVITY_CREATE });
    expect(sent(fetchMock, "mail.activity", "create")).toHaveLength(0);
  });

  it("blocks as refused a create the model fails with AttributeError, when the probe let it through", async () => {
    await db.addNote(makeNote({ id: "ac-24" }));
    vi.stubGlobal("fetch", server({ createError: "builtins.AttributeError" }));
    await svc.setActivity("ac-24", CONFIG_ID, ON_PARTNER);
    const err = await svc.pushNote(CREDS, "ac-24", { userInitiated: true }).catch((e) => e);
    expect(err).toMatchObject({ reason: "refused" });
    expect(await svc.hasDueWork(CONFIG_ID)).toBe(false);
  });

  it("leaves untouched, as done, an activity archived on the server (Odoo 17+)", async () => {
    await db.addNote(makeNote({ id: "ac-25" }));
    vi.stubGlobal("fetch", server());
    await svc.setActivity("ac-25", CONFIG_ID, ON_PARTNER);
    await svc.pushNote(CREDS, "ac-25", { userInitiated: true });
    await db.updateNote("ac-25", makeNote({ id: "ac-25", done: true }));

    const fetchMock = server({ archived: [500] });
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "ac-25");
    const read = sent(fetchMock, "mail.activity", "search_read")[0];
    expect((read.body.params as any).kwargs).toMatchObject({ fields: expect.arrayContaining(["active"]), context: { active_test: false } });
    expect(sent(fetchMock, "mail.activity", "action_feedback")).toHaveLength(0);
    expect(sent(fetchMock, "mail.activity", "write")).toHaveLength(0);
    expect((await activityLinks("ac-25"))[0].remoteState).toBe("done");
  });

  it("does not read active on Odoo 16, whose activities have none", async () => {
    await SecureStoragePlugin.set({
      key: syncSessionKey(CREDS),
      value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 16 }),
    });
    await db.addNote(makeNote({ id: "ac-26" }));
    vi.stubGlobal("fetch", server());
    await svc.setActivity("ac-26", CONFIG_ID, ON_PARTNER);
    await svc.pushNote(CREDS, "ac-26", { userInitiated: true });
    await db.updateNote("ac-26", makeNote({ id: "ac-26", title: "Changed" }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "ac-26");
    for (const read of sent(fetchMock, "mail.activity", "search_read")) {
      expect((read.body.params as any).kwargs.fields).not.toContain("active");
    }
    expect(sent(fetchMock, "mail.activity", "write")).toHaveLength(1);
  });

  it("cancels, without running it, a creation whose activity was linked before its row was deleted", async () => {
    await db.addNote(makeNote({ id: "ac-27" }));
    const op = (await svc.setActivity("ac-27", CONFIG_ID, ON_PARTNER))!;
    await db.addNoteLink({
      id: "lk-27", noteId: "ac-27", configId: CONFIG_ID, model: "mail.activity", resId: 505, kind: "activity",
      remoteState: "ok", createdAt: "2026-01-01T00:00:00.000Z", lastSyncedAt: null, clientUuid: op.clientUuid,
      params: ON_PARTNER,
    });
    expect((await svc.activityStates("ac-27", CONFIG_ID)).map((a) => a.state)).toEqual(["linked"]);
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "ac-27", { userInitiated: true });
    expect(await db.getOutboxOp(op.id)).toBeNull();
    expect(sent(fetchMock, "mail.activity", "create")).toHaveLength(0);
    expect(await activityLinks("ac-27")).toHaveLength(1);
  });

  it("blocks a create the server refuses until chosen again", async () => {
    await db.addNote(makeNote({ id: "ac-12" }));
    vi.stubGlobal("fetch", server({ createError: "odoo.exceptions.AccessError" }));
    const op = (await svc.setActivity("ac-12", CONFIG_ID, ON_PARTNER))!;
    const err = await svc.pushNote(CREDS, "ac-12", { userInitiated: true }).catch((e) => e);
    expect(err).toMatchObject({ reason: "refused", opId: op.id });
    expect((await db.getOutboxOp(op.id))!.params.createSentAt).toBeNull();
    expect((await svc.activityStates("ac-12", CONFIG_ID))[0]).toMatchObject({ state: "choose", reason: "refused" });

    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.setActivity("ac-12", CONFIG_ID, { ...ON_PARTNER, userId: null }, op.id);
    await svc.pushNote(CREDS, "ac-12", { userInitiated: true });
    expect(sent(fetchMock, "mail.activity", "create")[0].body.params.args![0]).not.toHaveProperty("user_id");
  });

  it("waits, without a request, for the record of an activity chosen offline", async () => {
    await db.addNote(makeNote({ id: "ac-13" }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    const op = (await svc.setActivity("ac-13", CONFIG_ID, { ...ON_PARTNER, resId: null }))!;
    expect(op.status).toBe("incomplete");
    const err = await svc.pushNote(CREDS, "ac-13", { userInitiated: true }).catch((e) => e);
    expect(err).toMatchObject({ reason: "incomplete", opKind: ACTIVITY_CREATE });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await svc.hasDueWork(CONFIG_ID)).toBe(false);
    expect(await db.refreshNoteSyncStatus("ac-13")).toBe("pending");

    await svc.setActivity("ac-13", CONFIG_ID, ON_PARTNER, op.id);
    expect((await db.getOutboxOp(op.id))!.status).toBe("queued");
    expect(await svc.hasDueWork(CONFIG_ID)).toBe(true);
  });

  it("changes nothing for an opId that does not wait for a choice", async () => {
    await db.addNote(makeNote({ id: "ac-14" }));
    const op = (await svc.setActivity("ac-14", CONFIG_ID, ON_PARTNER))!;
    expect(await svc.setActivity("ac-14", CONFIG_ID, { ...ON_PARTNER, resId: 6 }, op.id)).toBeNull();
    expect((await db.getOutboxOp(op.id))!.params.resId).toBe(5);
  });

  it("drops a creation removed in the picker, and only the note's own", async () => {
    await db.addNote(makeNote({ id: "ac-15" }));
    await db.addNote(makeNote({ id: "ac-16" }));
    const op = (await svc.setActivity("ac-15", CONFIG_ID, ON_PARTNER))!;
    await svc.dropAttached("ac-16", op.id);
    expect(await db.getOutboxOp(op.id)).not.toBeNull();
    await svc.dropAttached("ac-15", op.id);
    expect(await db.getOutboxOp(op.id)).toBeNull();
    expect(await db.refreshNoteSyncStatus("ac-15")).toBe("local");
  });

  it("adopts the activity a lost create made, found by its marker in note", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await db.addNote(makeNote({ id: "ac-17" }));
    vi.stubGlobal("fetch", routeFetch((_url, body) => {
      const { model, method } = body.params as any;
      if (model === "mail.activity" && method === "create") throw new TypeError("Failed to fetch");
      const kwargs = (body.params as any).kwargs ?? {};
      return { result: kwargs.domain?.[0]?.[0] === "id" ? [{ id: kwargs.domain[0][2] }] : [] };
    }));
    await svc.setActivity("ac-17", CONFIG_ID, ON_PARTNER);
    await svc.pushNote(CREDS, "ac-17", { userInitiated: true }).catch(() => {});

    afterQuietWindow();
    const fetchMock = server({ markerHits: [777] });
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "ac-17", { userInitiated: true });
    const search = rpcCalls(fetchMock).find((c) => (c.body.params as any).kwargs?.domain?.[0]?.[0] === "note")!;
    expect(search.body.params.model).toBe("mail.activity");
    expect(sent(fetchMock, "mail.activity", "create")).toHaveLength(0);
    expect(sent(fetchMock, "mail.activity", "write")[0].body.params.args![0]).toEqual([777]);
    expect((await activityLinks("ac-17"))[0].resId).toBe(777);
  });

  it("asks which activity is the note's when several carry its marker, then adopts the one picked", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await db.addNote(makeNote({ id: "ac-18" }));
    vi.stubGlobal("fetch", routeFetch((_url, body) => {
      if ((body.params as any).method === "create") throw new TypeError("Failed to fetch");
      const kwargs = (body.params as any).kwargs ?? {};
      return { result: kwargs.domain?.[0]?.[0] === "id" ? [{ id: kwargs.domain[0][2] }] : [] };
    }));
    const op = (await svc.setActivity("ac-18", CONFIG_ID, ON_PARTNER))!;
    await svc.pushNote(CREDS, "ac-18", { userInitiated: true }).catch(() => {});
    afterQuietWindow();
    vi.stubGlobal("fetch", server({ markerHits: [701, 702] }));
    const err = await svc.pushNote(CREDS, "ac-18", { userInitiated: true }).catch((e) => e);
    expect(err).toMatchObject({ reason: "ambiguous", candidates: [701, 702], opKind: ACTIVITY_CREATE, opId: op.id });

    vi.stubGlobal("fetch", server({ markerHits: [701, 702] }));
    await svc.pushNote(CREDS, "ac-18", { userInitiated: true, adopt: { kind: "activity", opId: op.id, resId: 702 } });
    expect((await activityLinks("ac-18"))[0].resId).toBe(702);
  });

  it("runs a due activity creation from the outbox, and a task beside it as before", async () => {
    await db.addNote(makeNote({ id: "ac-19" }));
    await linkTask(db, "ac-19", 10);
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.setActivity("ac-19", CONFIG_ID, ON_PARTNER);
    const result = await svc.outbox.drain(CREDS, CONFIG_ID);
    expect(result.done).toBe(1);
    expect(sent(fetchMock, "mail.activity", "create")).toHaveLength(1);
    expect(sent(fetchMock, "project.task", "write")).toHaveLength(0);
    expect(await svc.noteKinds("ac-19", CONFIG_ID)).toEqual(["task"]);
  });

  it("pushes in the background a pending note whose only target is a live activity", async () => {
    await db.addNote(makeNote({ id: "ac-21" }));
    vi.stubGlobal("fetch", server());
    await svc.setActivity("ac-21", CONFIG_ID, ON_PARTNER);
    await svc.pushNote(CREDS, "ac-21", { userInitiated: true });
    await db.updateNote("ac-21", makeNote({ id: "ac-21", title: "Changed" }));
    await db.setNotePerServerStatus("ac-21", CONFIG_ID, "pending");
    expect(await svc.hasDueWork(CONFIG_ID)).toBe(true);

    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    expect((await svc.syncAll(CREDS)).pushed).toBe(1);
    expect(sent(fetchMock, "mail.activity", "write")).toHaveLength(1);
  });

  it("skips silently in the background a deleted task beside a live activity", async () => {
    await db.addNote(makeNote({ id: "ac-22" }));
    await linkTask(db, "ac-22", 10);
    await db.setNoteLinkRemoteDeleted(`link-ac-22-${CONFIG_ID}`);
    vi.stubGlobal("fetch", server());
    await svc.setActivity("ac-22", CONFIG_ID, ON_PARTNER);
    await svc.pushNote(CREDS, "ac-22", { userInitiated: true }).catch(() => {});
    await db.updateNote("ac-22", makeNote({ id: "ac-22", title: "Changed" }));
    await db.setNotePerServerStatus("ac-22", CONFIG_ID, "pending");

    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await expect(svc.pushNote(CREDS, "ac-22")).resolves.toBeUndefined();
    expect(sent(fetchMock, "mail.activity", "write")).toHaveLength(1);
    expect((await db.getNotePerServerStatus("ac-22"))[CONFIG_ID]).toBe("synced");
  });

  it("keeps the note queued on a server where its task is gone but an activity lives", async () => {
    await db.addNote(makeNote({ id: "ac-20" }));
    await linkTask(db, "ac-20", 10);
    vi.stubGlobal("fetch", server());
    await svc.setActivity("ac-20", CONFIG_ID, ON_PARTNER);
    await svc.pushNote(CREDS, "ac-20", { userInitiated: true });
    await db.setNotePerServerStatus("ac-20", CONFIG_ID, "pending");

    vi.stubGlobal("fetch", routeFetch((_url, body) => {
      const { model } = body.params as any;
      if (model === "project.task") {
        return { error: { code: 200, message: "Odoo Server Error", data: { name: "odoo.exceptions.MissingError", message: "gone" } } };
      }
      return { result: true };
    }));
    await expect(svc.pushNote(CREDS, "ac-20")).rejects.toBeInstanceOf(RemoteRecordDeletedError);
    expect((await db.getNotePerServerStatus("ac-20"))[CONFIG_ID]).toBe("synced");
    expect((await activityLinks("ac-20"))[0].remoteState).toBe("ok");
  });
});

describe("SyncService — messages in a record's chatter", () => {
  let svc: SyncService;
  let db: DatabaseService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await prepareSyncDb(db);
    await db.addParamsToNoteLinks();
    svc = new SyncService(db);
    await session(17);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const session = (version: number) => SecureStoragePlugin.set({
    key: syncSessionKey(CREDS),
    value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: version }),
  });

  const ON_LEAD = {
    resModel: "crm.lead", resId: 7, resName: "Big deal", typeId: null, deadline: null, userId: null,
  };

  /**
   * Server with lead 7; message_post answers 600, 601, …, each message
   * read back with attachments (emptied: deleted in the chatter);
   * updateError makes the edit route answer that exception; noChatter
   * models have no message_ids.
   */
  function server(options: {
    updateError?: string; markerHits?: number[]; noChatter?: string[]; attachments?: number[]; emptied?: boolean;
  } = {}) {
    let next = 600;
    const fail = (name: string) => ({ error: { code: 200, message: "Odoo Server Error", data: { name, message: "nope" } } });
    return routeFetch((url, body) => {
      if (url.endsWith("/mail/message/update_content")) {
        return options.updateError ? fail(options.updateError) : { result: { id: (body.params as any).message_id } };
      }
      const { model, method } = body.params as any;
      const kwargs = (body.params as any).kwargs ?? {};
      if (method === "fields_get") {
        return { result: options.noChatter?.includes(model) ? { name: {} } : { name: {}, message_ids: {} } };
      }
      if (model === "mail.message" && method === "search_read" && kwargs.domain?.[0]?.[0] === "id") {
        const id = kwargs.domain[0][2];
        if (options.emptied) return { result: [{ id, body: "", attachment_ids: [] }] };
        return { result: [{ id, body: "<p>posted</p>", attachment_ids: options.attachments ?? [] }] };
      }
      if (model === "mail.message" && method === "search_read") {
        return { result: (options.markerHits ?? []).map((id) => ({ id })) };
      }
      if (method === "search_read" && kwargs.domain?.[0]?.[0] === "id") {
        return { result: kwargs.domain[0][2] === 7 ? [{ id: 7 }] : [] };
      }
      if (method === "message_post") return { result: next++ };
      return { result: method === "search_read" ? [] : true };
    });
  }

  const sent = (fetchMock: ReturnType<typeof routeFetch>, model: string, method: string) =>
    rpcCalls(fetchMock).filter((c) => c.body.params.model === model && c.body.params.method === method);
  const edits = (fetchMock: ReturnType<typeof routeFetch>) =>
    rpcCalls(fetchMock).filter((c) => c.url.endsWith("/mail/message/update_content"));
  const messageLinks = async (noteId: string) => (await db.getNoteLinks(noteId)).filter((l) => l.kind === "message");

  it("posts the note as a logged note on the chosen record, without a task", async () => {
    await db.addNote(makeNote({ id: "ms-1", title: "Call <summary>", entries: [{ id: "e", type: "text", params: { text: "They agree", readonly: false } } as any] }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.setMessage("ms-1", CONFIG_ID, { ...ON_LEAD, typeId: 3, deadline: "2026-11-02", userId: 8 });
    expect(await svc.noteKinds("ms-1", CONFIG_ID)).toEqual([]);
    await svc.pushNote(CREDS, "ms-1", { userInitiated: true });

    const [post] = sent(fetchMock, "crm.lead", "message_post");
    expect(post.body.params.args).toEqual([[7]]);
    const kwargs = (post.body.params as any).kwargs;
    expect(kwargs).toMatchObject({ body_is_html: true, message_type: "comment", subtype_xmlid: "mail.mt_note" });
    expect(kwargs.body).toContain("<p><b>Call &lt;summary&gt;</b></p>");
    expect(kwargs.body).toContain("They agree");
    expect(kwargs.body).toContain("erplibre-mobile:");
    expect(sent(fetchMock, "project.task", "create")).toHaveLength(0);
    const [link] = await messageLinks("ms-1");
    expect(link).toMatchObject({ model: "mail.message", resId: 600, remoteState: "ok" });
    expect(link.params).toMatchObject({ resModel: "crm.lead", resId: 7, typeId: null, deadline: null, userId: null });
    expect(link.params!.bodyHash).toMatch(/^[0-9a-f]+$/);
    expect((await db.getNoteSyncInfo("ms-1")).syncStatus).toBe("synced");
  });

  it("sends no body_is_html to Odoo 16, which does not know it", async () => {
    await session(16);
    await db.addNote(makeNote({ id: "ms-2" }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.setMessage("ms-2", CONFIG_ID, ON_LEAD);
    await svc.pushNote(CREDS, "ms-2", { userInitiated: true });
    expect((sent(fetchMock, "crm.lead", "message_post")[0].body.params as any).kwargs).not.toHaveProperty("body_is_html");
  });

  it("edits the posted message when the note's text changes, and only then", async () => {
    await db.addNote(makeNote({ id: "ms-3" }));
    vi.stubGlobal("fetch", server());
    await svc.setMessage("ms-3", CONFIG_ID, ON_LEAD);
    await svc.pushNote(CREDS, "ms-3", { userInitiated: true });

    const unchanged = server();
    vi.stubGlobal("fetch", unchanged);
    await svc.pushNote(CREDS, "ms-3", { userInitiated: true });
    expect(edits(unchanged)).toHaveLength(0);
    expect(sent(unchanged, "crm.lead", "message_post")).toHaveLength(0);

    await db.updateNote("ms-3", makeNote({ id: "ms-3", title: "Renamed" }));
    const changed = server();
    vi.stubGlobal("fetch", changed);
    await svc.pushNote(CREDS, "ms-3");
    const [edit] = edits(changed);
    expect(edit.body.params).toMatchObject({ message_id: 600, attachment_ids: [] });
    expect((edit.body.params as any).body).toContain("Renamed");

    const again = server();
    vi.stubGlobal("fetch", again);
    await svc.pushNote(CREDS, "ms-3");
    expect(edits(again)).toHaveLength(0);
  });

  it("keeps as history a message deleted on the server, without raising", async () => {
    await db.addNote(makeNote({ id: "ms-4" }));
    vi.stubGlobal("fetch", server());
    await svc.setMessage("ms-4", CONFIG_ID, ON_LEAD);
    await svc.pushNote(CREDS, "ms-4", { userInitiated: true });
    await db.updateNote("ms-4", makeNote({ id: "ms-4", title: "Changed" }));
    await db.setNotePerServerStatus("ms-4", CONFIG_ID, "pending");

    vi.stubGlobal("fetch", server({ updateError: "werkzeug.exceptions.NotFound" }));
    await expect(svc.pushNote(CREDS, "ms-4")).resolves.toBeUndefined();
    expect((await messageLinks("ms-4"))[0].remoteState).toBe("deleted");
    expect(await db.getNotePerServerStatus("ms-4")).toEqual({});
    expect((await svc.attachedStates("ms-4", CONFIG_ID))[0]).toMatchObject({ kind: "message", state: "deleted" });
  });

  it("raises an edit the server refuses for another reason", async () => {
    await db.addNote(makeNote({ id: "ms-5" }));
    vi.stubGlobal("fetch", server());
    await svc.setMessage("ms-5", CONFIG_ID, ON_LEAD);
    await svc.pushNote(CREDS, "ms-5", { userInitiated: true });
    await db.updateNote("ms-5", makeNote({ id: "ms-5", title: "Changed" }));
    vi.stubGlobal("fetch", server({ updateError: "odoo.exceptions.UserError" }));
    await expect(svc.pushNote(CREDS, "ms-5")).rejects.toThrow("nope");
    expect((await messageLinks("ms-5"))[0].remoteState).toBe("ok");
  });

  it("adopts the message a lost post made, searched by its marker on its record only", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await db.addNote(makeNote({ id: "ms-6" }));
    vi.stubGlobal("fetch", routeFetch((_url, body) => {
      const { method } = body.params as any;
      if (method === "message_post") throw new TypeError("Failed to fetch");
      const kwargs = (body.params as any).kwargs ?? {};
      if (method === "fields_get") return { result: { message_ids: {} } };
      return { result: kwargs.domain?.[0]?.[0] === "id" ? [{ id: 7 }] : [] };
    }));
    await svc.setMessage("ms-6", CONFIG_ID, ON_LEAD);
    await svc.pushNote(CREDS, "ms-6", { userInitiated: true }).catch(() => {});

    afterQuietWindow();
    const fetchMock = server({ markerHits: [650] });
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "ms-6", { userInitiated: true });
    const search = sent(fetchMock, "mail.message", "search_read")[0];
    const domain = (search.body.params as any).kwargs.domain;
    expect(domain.slice(0, 2)).toEqual([["model", "=", "crm.lead"], ["res_id", "=", 7]]);
    expect(domain[2][0]).toBe("body");
    expect(sent(fetchMock, "crm.lead", "message_post")).toHaveLength(0);
    // Found as it was posted: not edited, so not marked edited
    expect(edits(fetchMock)).toHaveLength(0);
    const [link] = await messageLinks("ms-6");
    expect(link.resId).toBe(650);
    expect(link.params!.bodyHash).toMatch(/^[0-9a-f]+$/);
  });

  it("edits a message found again by its marker when the note changed since it was posted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await db.addNote(makeNote({ id: "ms-9" }));
    vi.stubGlobal("fetch", routeFetch((_url, body) => {
      const { method } = body.params as any;
      if (method === "message_post") throw new TypeError("Failed to fetch");
      const kwargs = (body.params as any).kwargs ?? {};
      if (method === "fields_get") return { result: { message_ids: {} } };
      return { result: kwargs.domain?.[0]?.[0] === "id" ? [{ id: 7 }] : [] };
    }));
    await svc.setMessage("ms-9", CONFIG_ID, ON_LEAD);
    await svc.pushNote(CREDS, "ms-9", { userInitiated: true }).catch(() => {});
    await db.updateNote("ms-9", makeNote({ id: "ms-9", title: "Edited offline" }));

    afterQuietWindow();
    const fetchMock = server({ markerHits: [650], attachments: [41] });
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "ms-9", { userInitiated: true });
    const [edit] = edits(fetchMock);
    expect(edit.body.params).toMatchObject({ message_id: 650, attachment_ids: [41] });
    expect((edit.body.params as any).body).toContain("Edited offline");
  });

  it("reads the message through call_kw before editing it, and passes its attachments back", async () => {
    await db.addNote(makeNote({ id: "ms-10" }));
    vi.stubGlobal("fetch", server());
    await svc.setMessage("ms-10", CONFIG_ID, ON_LEAD);
    await svc.pushNote(CREDS, "ms-10", { userInitiated: true });
    await db.updateNote("ms-10", makeNote({ id: "ms-10", title: "Changed" }));

    const fetchMock = server({ attachments: [41, 42] });
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "ms-10");
    const calls = rpcCalls(fetchMock);
    const read = calls.findIndex((c) => c.body.params.model === "mail.message" && c.body.params.method === "search_read");
    const edit = calls.findIndex((c) => c.url.endsWith("/mail/message/update_content"));
    expect(read).toBeGreaterThanOrEqual(0);
    expect(read).toBeLessThan(edit);
    expect(calls[edit].body.params).toMatchObject({ attachment_ids: [41, 42] });
  });

  it("keeps as history, without editing it, a message deleted in the chatter", async () => {
    await db.addNote(makeNote({ id: "ms-11" }));
    vi.stubGlobal("fetch", server());
    await svc.setMessage("ms-11", CONFIG_ID, ON_LEAD);
    await svc.pushNote(CREDS, "ms-11", { userInitiated: true });
    await db.updateNote("ms-11", makeNote({ id: "ms-11", title: "Changed" }));

    const fetchMock = server({ emptied: true });
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "ms-11");
    expect(edits(fetchMock)).toHaveLength(0);
    expect((await messageLinks("ms-11"))[0].remoteState).toBe("deleted");
  });

  it("keeps the HTML of an unchanged note with media the same from one push to the next", async () => {
    const entries = [
      { id: "a", type: "audio", params: { path: "a.m4a" } },
      { id: "p", type: "photo", params: { path: "p.jpg" } },
      { id: "v", type: "video", params: { path: "v.mp4" } },
    ] as any;
    vi.useFakeTimers({ toFake: ["Date"] });
    const first = svc.buildHtml(entries);
    vi.setSystemTime(Date.now() + 60_000);
    expect(svc.buildHtml(entries)).toBe(first);
  });

  it("blocks a message on a model without a chatter, without posting it", async () => {
    await db.addNote(makeNote({ id: "ms-7" }));
    const fetchMock = server({ noChatter: ["res.country"] });
    vi.stubGlobal("fetch", fetchMock);
    const op = (await svc.setMessage("ms-7", CONFIG_ID, { ...ON_LEAD, resModel: "res.country" }))!;
    const err = await svc.pushNote(CREDS, "ms-7", { userInitiated: true }).catch((e) => e);
    expect(err).toMatchObject({ reason: "model_unusable", opKind: MESSAGE_POST, opId: op.id });
    expect(rpcCalls(fetchMock).some((c) => (c.body.params as any).method === "message_post")).toBe(false);
  });

  it("does not mark a message done with the note, and posts several apart", async () => {
    await db.addNote(makeNote({ id: "ms-8", done: true }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.setMessage("ms-8", CONFIG_ID, ON_LEAD);
    await svc.setMessage("ms-8", CONFIG_ID, ON_LEAD);
    await svc.syncAll(CREDS);
    expect(sent(fetchMock, "crm.lead", "message_post")).toHaveLength(2);
    expect(rpcCalls(fetchMock).some((c) => (c.body.params as any).method === "action_feedback")).toBe(false);
    expect((await messageLinks("ms-8")).map((l) => [l.resId, l.remoteState]).sort()).toEqual([[600, "ok"], [601, "ok"]]);
  });
});

describe("SyncService — draft invoice", () => {
  let svc: SyncService;
  let db: DatabaseService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await prepareSyncDb(db);
    await db.addParamsToNoteLinks();
    svc = new SyncService(db);
    await SecureStoragePlugin.set({
      key: syncSessionKey(CREDS),
      value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 17 }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const INVOICE = {
    moveType: "out_invoice" as const, partnerId: 5, partnerName: "Acme", invoiceDate: "2026-11-01", ref: "PO-4",
    lines: [{ name: "Work", quantity: 2, priceUnit: 50, productId: 3, productName: "Hour" }, { name: "Trip", quantity: 1, priceUnit: 20, productId: null }],
    extra: { x_site: 9 }, linkKind: null,
  };

  /**
   * Server with partner 5; invoice creates answer 800, task creates 900;
   * tieField: account.move has a settable many2one of that name to
   * project.task; postError makes message_post fail.
   */
  function server(options: { tieField?: string; postError?: boolean; createError?: string; markerHits?: number[]; posted?: number } = {}) {
    const fail = (name: string) => ({ error: { code: 200, message: "Odoo Server Error", data: { name, message: "nope" } } });
    return routeFetch((_url, body) => {
      const { model, method } = body.params as any;
      const kwargs = (body.params as any).kwargs ?? {};
      if (model === "account.move" && method === "fields_get") {
        return { result: {
          name: { type: "char" },
          ...(options.tieField ? { [options.tieField]: { type: "many2one", relation: "project.task", depends: [] } } : {}),
          x_computed_task: { type: "many2one", relation: "project.task", depends: ["line_ids"] },
        } };
      }
      if (model === "res.partner" && method === "search_read") return { result: kwargs.domain[0][2] === 5 ? [{ id: 5 }] : [] };
      if (method === "message_post") return options.postError ? fail("odoo.exceptions.AccessError") : { result: 77 };
      if (model === "mail.message" && method === "search_count") return { result: options.posted ?? 0 };
      if (model === "account.move" && method === "search_read" && kwargs.domain?.[0]?.[0] === "narration") {
        return { result: (options.markerHits ?? []).map((id) => ({ id })) };
      }
      if (model === "account.move" && method === "create") return options.createError ? fail(options.createError) : { result: 800 };
      if (method === "create") return { result: 900 };
      return { result: method === "search_read" ? [] : true };
    });
  }

  const sent = (fetchMock: ReturnType<typeof routeFetch>, model: string, method: string) =>
    rpcCalls(fetchMock).filter((c) => c.body.params.model === model && c.body.params.method === method);

  it("creates the draft with its type, partner, date, reference, lines and extra fields, without a task", async () => {
    await db.addNote(makeNote({ id: "iv-1", title: "Job", tags: ["urgent"], entries: [{ id: "e", type: "text", params: { text: "Done on site", readonly: false } } as any] }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.setTarget("iv-1", CONFIG_ID, "invoice", INVOICE);
    expect(await svc.noteKinds("iv-1", CONFIG_ID)).toEqual(["invoice"]);
    await svc.pushNote(CREDS, "iv-1", { userInitiated: true });

    const [create] = sent(fetchMock, "account.move", "create");
    const values = create.body.params.args![0];
    expect(values).toMatchObject({
      move_type: "out_invoice", partner_id: 5, invoice_date: "2026-11-01", ref: "PO-4", x_site: 9,
      invoice_line_ids: [
        [0, 0, { name: "Work", quantity: 2, price_unit: 50, product_id: 3 }],
        [0, 0, { name: "Trip", quantity: 1, price_unit: 20 }],
      ],
    });
    expect(values.narration).toContain("<p><b>Job</b></p>");
    expect(values.narration).toContain("Done on site");
    expect(values.narration).toContain("erplibre-mobile:");
    expect(values).not.toHaveProperty("tag_ids");
    expect((create.body.params as any).kwargs.context).toEqual({ default_move_type: "out_invoice" });
    expect(sent(fetchMock, "project.task", "create")).toHaveLength(0);
    expect((await db.findNoteLink("iv-1", CONFIG_ID, "account.move", "create"))!.resId).toBe(800);
  });

  it("writes only the narration of a linked invoice", async () => {
    await db.addNote(makeNote({ id: "iv-2", title: "Renamed" }));
    await db.addNoteLink({
      id: "lk-iv-2", noteId: "iv-2", configId: CONFIG_ID, model: "account.move", resId: 80, kind: "create",
      remoteState: "ok", createdAt: "2026-01-01T00:00:00.000Z", lastSyncedAt: null,
    });
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "iv-2");
    const [ids, values] = sent(fetchMock, "account.move", "write")[0].body.params.args!;
    expect(ids).toEqual([80]);
    expect(Object.keys(values)).toEqual(["narration"]);
    expect(values.narration).toContain("Renamed");
  });

  it("ties the invoice to the note's task through a settable field when the server has one", async () => {
    await db.addNote(makeNote({ id: "iv-3" }));
    await linkTask(db, "iv-3", 10);
    const fetchMock = server({ tieField: "x_task_id" });
    vi.stubGlobal("fetch", fetchMock);
    await svc.setTarget("iv-3", CONFIG_ID, "invoice", { ...INVOICE, linkKind: "task" });
    await svc.pushNote(CREDS, "iv-3", { userInitiated: true });
    const values = sent(fetchMock, "account.move", "create")[0].body.params.args![0];
    expect(values.x_task_id).toBe(10);
    expect(values).not.toHaveProperty("x_computed_task");
    expect(rpcCalls(fetchMock).some((c) => (c.body.params as any).method === "message_post")).toBe(false);
  });

  it("ties it by a message in each chatter when there is no such field", async () => {
    await db.addNote(makeNote({ id: "iv-4" }));
    await linkTask(db, "iv-4", 10);
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.setTarget("iv-4", CONFIG_ID, "invoice", { ...INVOICE, linkKind: "task" });
    await svc.pushNote(CREDS, "iv-4", { userInitiated: true });
    const onInvoice = sent(fetchMock, "account.move", "message_post")[0];
    const onTask = sent(fetchMock, "project.task", "message_post")[0];
    expect(onInvoice.body.params.args).toEqual([[800]]);
    expect((onInvoice.body.params as any).kwargs.body).toContain('data-oe-model="project.task" data-oe-id="10"');
    expect(onTask.body.params.args).toEqual([[10]]);
    expect((onTask.body.params as any).kwargs.body).toContain('data-oe-model="account.move" data-oe-id="800"');
    expect((await db.findNoteLink("iv-4", CONFIG_ID, "account.move", "create"))!.params).toMatchObject({ crossLinked: true });
  });

  it("keeps the invoice when the cross messages fail, with the reason", async () => {
    await db.addNote(makeNote({ id: "iv-5" }));
    await linkTask(db, "iv-5", 10);
    vi.stubGlobal("fetch", server({ postError: true }));
    await svc.setTarget("iv-5", CONFIG_ID, "invoice", { ...INVOICE, linkKind: "task" });
    await expect(svc.pushNote(CREDS, "iv-5", { userInitiated: true })).resolves.toBeUndefined();
    const link = (await db.findNoteLink("iv-5", CONFIG_ID, "account.move", "create"))!;
    expect(link.resId).toBe(800);
    expect(link.params).toMatchObject({ crossLinked: false, crossError: expect.stringContaining("nope") });
  });

  it("waits for the task it is tied to when both are created together", async () => {
    await db.addNote(makeNote({ id: "iv-6" }));
    const task = (await svc.setTarget("iv-6", CONFIG_ID, "task", { projectId: null }))!;
    const invoice = (await svc.setTarget("iv-6", CONFIG_ID, "invoice", { ...INVOICE, linkKind: "task" }))!;
    expect(invoice.dependsOn).toBe(task.id);
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "iv-6", { userInitiated: true });
    expect(sent(fetchMock, "project.task", "message_post")[0].body.params.args).toEqual([[900]]);
  });

  it("blocks an invoice whose partner is gone, and one the server refuses", async () => {
    await db.addNote(makeNote({ id: "iv-7" }));
    vi.stubGlobal("fetch", server());
    await svc.setTarget("iv-7", CONFIG_ID, "invoice", { ...INVOICE, partnerId: 99 });
    const gone = await svc.pushNote(CREDS, "iv-7", { userInitiated: true }).catch((e) => e);
    expect(gone).toMatchObject({ reason: "partner_missing", opKind: INVOICE_CREATE });

    await db.addNote(makeNote({ id: "iv-8" }));
    vi.stubGlobal("fetch", server({ createError: "odoo.exceptions.ValidationError" }));
    await svc.setTarget("iv-8", CONFIG_ID, "invoice", INVOICE);
    const refused = await svc.pushNote(CREDS, "iv-8", { userInitiated: true }).catch((e) => e);
    expect(refused).toMatchObject({ reason: "refused" });
    expect(await svc.targetState("iv-8", CONFIG_ID, "invoice")).toMatchObject({ state: "choose", reason: "refused", target: { ref: "PO-4" } });
  });

  it("does not create an invoice before the task it is tied to, which waits for its project", async () => {
    await db.addNote(makeNote({ id: "iv-10" }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.setTarget("iv-10", CONFIG_ID, "task", "later");
    await svc.setTarget("iv-10", CONFIG_ID, "invoice", { ...INVOICE, linkKind: "task" });
    expect(await svc.hasDueWork(CONFIG_ID)).toBe(false);
    await svc.syncAll(CREDS, undefined, { force: true });
    const err = await svc.pushNote(CREDS, "iv-10", { userInitiated: true }).catch((e) => e);
    expect(err).toMatchObject({ reason: "incomplete" });
    expect(sent(fetchMock, "account.move", "create")).toHaveLength(0);

    await svc.setTarget("iv-10", CONFIG_ID, "task", { projectId: null });
    await svc.pushNote(CREDS, "iv-10", { userInitiated: true });
    expect(sent(fetchMock, "account.move", "create")).toHaveLength(1);
    expect(sent(fetchMock, "project.task", "message_post")[0].body.params.args).toEqual([[900]]);
  });

  it("counts as not due an invoice queued before the task it is tied to", async () => {
    await db.addNote(makeNote({ id: "iv-15" }));
    const invoice = (await svc.setTarget("iv-15", CONFIG_ID, "invoice", { ...INVOICE, linkKind: "task" }))!;
    expect(invoice.dependsOn).toBeNull();
    await svc.setTarget("iv-15", CONFIG_ID, "task", "later");
    expect(await svc.hasDueWork(CONFIG_ID)).toBe(false);
  });

  it("ties an invoice found again after a lost create, posting only the messages missing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await db.addNote(makeNote({ id: "iv-11" }));
    await linkTask(db, "iv-11", 10);
    vi.stubGlobal("fetch", routeFetch((_url, body) => {
      if ((body.params as any).method === "create") throw new TypeError("Failed to fetch");
      return { result: (body.params as any).method === "fields_get" ? {} : [] };
    }));
    await svc.setTarget("iv-11", CONFIG_ID, "invoice", { ...INVOICE, partnerId: null, linkKind: "task" });
    await svc.pushNote(CREDS, "iv-11", { userInitiated: true }).catch(() => {});
    afterQuietWindow();
    const fetchMock = server({ markerHits: [811] });
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "iv-11", { userInitiated: true });
    expect(sent(fetchMock, "account.move", "create")).toHaveLength(0);
    expect(sent(fetchMock, "mail.message", "search_count")).toHaveLength(2);
    expect(sent(fetchMock, "account.move", "message_post")[0].body.params.args).toEqual([[811]]);
    expect((await db.findNoteLink("iv-11", CONFIG_ID, "account.move", "create"))!.params).toMatchObject({ crossLinked: true });

    await db.addNote(makeNote({ id: "iv-12" }));
    await linkTask(db, "iv-12", 10);
    vi.stubGlobal("fetch", server({ markerHits: [812], posted: 1 }));
    await svc.setTarget("iv-12", CONFIG_ID, "invoice", { ...INVOICE, partnerId: null, linkKind: "task" });
    const already = server({ markerHits: [812], posted: 1 });
    vi.stubGlobal("fetch", already);
    const op = (await svc.targetState("iv-12", CONFIG_ID, "invoice")) as any;
    await svc.pushNote(CREDS, "iv-12", { userInitiated: true, adopt: { kind: "invoice", resId: 812 } });
    expect(op.state).toBe("queued");
    expect(rpcCalls(already).some((c) => (c.body.params as any).method === "message_post")).toBe(false);
  });

  it("leaves the price of a line to the server when none was typed, and refuses a malformed value", async () => {
    await db.addNote(makeNote({ id: "iv-13" }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.setTarget("iv-13", CONFIG_ID, "invoice", { ...INVOICE, lines: [{ name: "Hour", quantity: 1, priceUnit: null, productId: 3 }] });
    await svc.pushNote(CREDS, "iv-13", { userInitiated: true });
    const line = sent(fetchMock, "account.move", "create")[0].body.params.args![0].invoice_line_ids[0][2];
    expect(line).toEqual({ name: "Hour", quantity: 1, product_id: 3 });

    await db.addNote(makeNote({ id: "iv-14" }));
    vi.stubGlobal("fetch", server({ createError: "builtins.ValueError" }));
    await svc.setTarget("iv-14", CONFIG_ID, "invoice", INVOICE);
    const err = await svc.pushNote(CREDS, "iv-14", { userInitiated: true }).catch((e) => e);
    expect(err).toMatchObject({ reason: "refused" });
  });

  it("searches its marker in the narration on a retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await db.addNote(makeNote({ id: "iv-9" }));
    vi.stubGlobal("fetch", routeFetch((_url, body) => {
      if ((body.params as any).method === "create") throw new TypeError("Failed to fetch");
      const kwargs = (body.params as any).kwargs ?? {};
      return { result: kwargs.domain?.[0]?.[0] === "id" ? [{ id: kwargs.domain[0][2] }] : [] };
    }));
    await svc.setTarget("iv-9", CONFIG_ID, "invoice", INVOICE);
    await svc.pushNote(CREDS, "iv-9", { userInitiated: true }).catch(() => {});
    afterQuietWindow();
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "iv-9", { userInitiated: true });
    const search = rpcCalls(fetchMock).find((c) => c.body.params.model === "account.move" && c.body.params.method === "search_read")!;
    expect((search.body.params as any).kwargs.domain[0][0]).toBe("narration");
  });
});

describe("SyncService — two-way sync and conflicts", () => {
  let svc: SyncService;
  let db: DatabaseService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await prepareSyncDb(db);
    await db.addParamsToNoteLinks();
    svc = new SyncService(db);
    await SecureStoragePlugin.set({
      key: syncSessionKey(CREDS),
      value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 17 }),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  /**
   * A small Odoo keeping its records: create and write (tag commands 6, 4
   * and 3 included) change them, search_read reads them back by id or
   * write_date; edit() changes one as another user would.
   */
  function odoo() {
    const records: Record<string, Map<number, any>> = {
      "project.task": new Map(), "crm.lead": new Map(), "account.move": new Map(), "mail.activity": new Map(),
    };
    const tags: Record<string, Map<number, string>> = { "project.tags": new Map(), "crm.tag": new Map() };
    let nextId = 100;
    let clock = 0;
    const stamp = () => `2099-01-01 00:00:${String(++clock).padStart(2, "0")}`;
    const applyTags = (current: number[], commands: any[]): number[] => {
      let ids = [...current];
      for (const c of commands ?? []) {
        if (c[0] === 6) ids = [...c[2]];
        if (c[0] === 4 && !ids.includes(c[1])) ids.push(c[1]);
        if (c[0] === 3) ids = ids.filter((id) => id !== c[1]);
      }
      return ids;
    };
    const tagId = (model: string, name: string) => {
      for (const [id, n] of tags[model]) if (n === name) return id;
      const id = nextId++;
      tags[model].set(id, name);
      return id;
    };
    const writeValues = (rec: any, values: any) => {
      const { tag_ids, ...rest } = values;
      Object.assign(rec, rest);
      if (tag_ids) rec.tag_ids = applyTags(rec.tag_ids ?? [], tag_ids);
      rec.write_date = stamp();
    };
    const fetchMock = routeFetch((_url, body) => {
      const { model, method, args } = body.params as any;
      const kwargs = (body.params as any).kwargs ?? {};
      const domain: any[] = kwargs.domain ?? [];
      if (method === "fields_get") return { result: { name: {}, message_ids: {}, activity_ids: {} } };
      if (model === "res.partner" && method === "search_read") return { result: [{ id: 5 }] };
      if (model in tags) {
        if (method === "create") return { result: tagId(model, args[0].name) };
        if (method === "search_read") {
          const [field, , value] = domain[0];
          const rows = [...tags[model]].map(([id, name]) => ({ id, name }));
          return { result: rows.filter((r) => (field === "id" ? value.includes(r.id) : value.includes(r.name))) };
        }
      }
      if (model in records) {
        const table = records[model];
        if (method === "create") {
          const id = nextId++;
          const rec = { id, state: "01_in_progress", active: true, tag_ids: [] as number[], ...args[0] };
          rec.tag_ids = applyTags([], args[0].tag_ids ?? []);
          rec.write_date = stamp();
          table.set(id, rec);
          return { result: id };
        }
        if (method === "write") {
          for (const id of args[0]) if (table.has(id)) writeValues(table.get(id), args[1]);
          return { result: true };
        }
        if (method === "search_read") {
          let rows = [...table.values()];
          for (const [field, op, value] of domain) {
            if (field === "id" && op === "=") rows = rows.filter((r) => r.id === value);
            if (field === "id" && op === "in") rows = rows.filter((r) => value.includes(r.id));
            if (field === "id" && op === "not in") rows = rows.filter((r) => !value.includes(r.id));
            if (field === "write_date") rows = rows.filter((r) => r.write_date >= value);
            if (op === "ilike") rows = [];
          }
          return { result: rows.map((r) => ({ ...r })) };
        }
      }
      if (method === "message_post") return { result: 1 };
      return { result: method === "search_read" ? [] : true };
    });
    return {
      fetchMock,
      records,
      tags,
      tagId,
      edit: (model: string, id: number, values: any) => writeValues(records[model].get(id), values),
    };
  }

  /** The names of the app's tags of ids, a value no tag has as id kept as a name. */
  const tagNames = async (ids: string[]) => {
    const byId = new Map((await db.getAllTags()).map((t) => [t.id, t.name]));
    return ids.map((id) => byId.get(id) ?? id).sort();
  };

  const writes = (fetchMock: ReturnType<typeof routeFetch>, model: string) =>
    rpcCalls(fetchMock).filter((c) => c.body.params.model === model && c.body.params.method === "write")
      .map((c) => c.body.params.args![1]);

  /** A note sent once as a task: created, linked, its base set. */
  async function sentTask(server: ReturnType<typeof odoo>, id: string, over: Partial<Note> = {}) {
    await db.addNote(makeNote({ id, title: "Plan", tags: ["a"], entries: [{ id: "e", type: "text", params: { text: "First", readonly: false } } as any], ...over }));
    vi.stubGlobal("fetch", server.fetchMock);
    await svc.setTarget(id, CONFIG_ID, "task", { projectId: null });
    await svc.pushNote(CREDS, id, { userInitiated: true });
    return (await db.findNoteLink(id, CONFIG_ID, "project.task", "create"))!;
  }

  it("brings back into the note the title, text, tags and date changed on the server", async () => {
    const server = odoo();
    const link = await sentTask(server, "tw-1");
    expect(link.params!.base).toBeTruthy();
    server.edit("project.task", link.resId, {
      name: "Plan v2", description: "<p>Second</p><p>Third</p>", tag_ids: [[4, server.tagId("project.tags", "b")]],
      date_deadline: "2026-11-05 12:00:00",
    });
    await svc.syncAll(CREDS);
    const note = (await db.getNoteById("tw-1"))!;
    expect(note.title).toBe("Plan v2");
    expect(await tagNames(note.tags)).toEqual(["a", "b"]);
    expect(note.entries.filter((e) => e.type === "text").map((e) => (e.params as any).text)).toEqual(["Second", "Third"]);
    expect(note.entries.some((e) => e.type === "date")).toBe(true);
    expect((await db.getNotePerServerStatus("tw-1"))[CONFIG_ID]).toBe("synced");
  });

  it("merges a field changed on the server with another changed in the app, writing only the app's", async () => {
    const server = odoo();
    const link = await sentTask(server, "tw-2");
    server.edit("project.task", link.resId, { name: "Server title" });
    await db.updateNote("tw-2", { ...(await db.getNoteById("tw-2"))!, pinned: true });
    await db.setNotePerServerStatus("tw-2", CONFIG_ID, "pending");
    server.fetchMock.mockClear();
    await svc.pushNote(CREDS, "tw-2", { userInitiated: true });
    expect(writes(server.fetchMock, "project.task")).toEqual([{ priority: "1" }]);
    expect(server.records["project.task"].get(link.resId)).toMatchObject({ name: "Server title", priority: "1" });
    expect((await db.getNoteById("tw-2"))!.title).toBe("Server title");
  });

  it("stops on a field changed on both sides, then sends the version kept", async () => {
    const server = odoo();
    const link = await sentTask(server, "tw-3");
    server.edit("project.task", link.resId, { name: "Theirs" });
    await db.updateNote("tw-3", { ...(await db.getNoteById("tw-3"))!, title: "Mine" });
    await db.setNotePerServerStatus("tw-3", CONFIG_ID, "pending");
    server.fetchMock.mockClear();
    await expect(svc.pushNote(CREDS, "tw-3", { userInitiated: true })).rejects.toBeInstanceOf(SyncConflictError);
    expect(writes(server.fetchMock, "project.task")).toEqual([]);
    expect((await db.getNoteSyncInfo("tw-3")).syncStatus).toBe("conflict");
    const [conflict] = await svc.conflictsOf("tw-3");
    expect(conflict.fields).toEqual({ title: { mine: "Mine", theirs: "Theirs" } });
    expect(await svc.pendingNoteIds(CONFIG_ID)).not.toContain("tw-3");

    await svc.resolveConflict("tw-3", conflict.linkId, { title: "mine" });
    expect(await svc.conflictsOf("tw-3")).toEqual([]);
    await svc.pushNote(CREDS, "tw-3", { userInitiated: true });
    expect(server.records["project.task"].get(link.resId).name).toBe("Mine");
    expect((await db.getNoteSyncInfo("tw-3")).syncStatus).toBe("synced");
  });

  it("takes the server's version of a conflict when chosen", async () => {
    const server = odoo();
    const link = await sentTask(server, "tw-4");
    server.edit("project.task", link.resId, { name: "Theirs" });
    await db.updateNote("tw-4", { ...(await db.getNoteById("tw-4"))!, title: "Mine" });
    await svc.syncAll(CREDS);
    const [conflict] = await svc.conflictsOf("tw-4");
    await svc.resolveConflict("tw-4", conflict.linkId, { title: "theirs" });
    expect((await db.getNoteById("tw-4"))!.title).toBe("Theirs");
    server.fetchMock.mockClear();
    await svc.pushNote(CREDS, "tw-4", { userInitiated: true });
    expect(writes(server.fetchMock, "project.task")).toEqual([]);
  });

  it("adds and removes only the app's tags, leaving those others set", async () => {
    const server = odoo();
    const link = await sentTask(server, "tw-5", { tags: ["a", "b"] });
    server.edit("project.task", link.resId, { tag_ids: [[4, server.tagId("project.tags", "theirs")]] });
    await svc.syncAll(CREDS);
    // The pull turned every tag into the app's own; "b" is removed, "c" added
    const tagged = (await db.getNoteById("tw-5"))!;
    const idOf = async (name: string) => (await db.getAllTags()).find((t) => t.name === name)!.id;
    await db.updateNote("tw-5", { ...tagged, tags: [await idOf("a"), "c", await idOf("theirs")] });
    await db.setNotePerServerStatus("tw-5", CONFIG_ID, "pending");
    server.fetchMock.mockClear();
    await svc.pushNote(CREDS, "tw-5");
    const [values] = writes(server.fetchMock, "project.task");
    expect(values.tag_ids.map((c: any[]) => c[0]).sort()).toEqual([3, 4]);
    const names = server.records["project.task"].get(link.resId).tag_ids.map((id: number) => server.tags["project.tags"].get(id)).sort();
    expect(names).toEqual(["a", "c", "theirs"]);
  });

  it("writes a task's state only when done changes in the app, keeping one another user set", async () => {
    const server = odoo();
    const link = await sentTask(server, "tw-6");
    server.edit("project.task", link.resId, { state: "03_approved" });
    await svc.syncAll(CREDS);
    await db.updateNote("tw-6", { ...(await db.getNoteById("tw-6"))!, title: "Renamed" });
    await db.setNotePerServerStatus("tw-6", CONFIG_ID, "pending");
    await svc.pushNote(CREDS, "tw-6");
    expect(server.records["project.task"].get(link.resId)).toMatchObject({ name: "Renamed", state: "03_approved" });
    await db.updateNote("tw-6", { ...(await db.getNoteById("tw-6"))!, done: true });
    await db.setNotePerServerStatus("tw-6", CONFIG_ID, "pending");
    await svc.pushNote(CREDS, "tw-6");
    expect(server.records["project.task"].get(link.resId).state).toBe("1_done");
  });

  it("brings back an opportunity's, an invoice's and an activity's changes", async () => {
    const server = odoo();
    vi.stubGlobal("fetch", server.fetchMock);
    await db.addNote(makeNote({ id: "tw-7", title: "Deal" }));
    await svc.setTarget("tw-7", CONFIG_ID, "lead", { partnerId: null });
    await svc.pushNote(CREDS, "tw-7", { userInitiated: true });
    const lead = (await db.findNoteLink("tw-7", CONFIG_ID, "crm.lead", "create"))!;
    server.edit("crm.lead", lead.resId, { name: "Deal 2", tag_ids: [[4, server.tagId("crm.tag", "hot")]] });

    await db.addNote(makeNote({ id: "tw-8", title: "Bill" }));
    await svc.setTarget("tw-8", CONFIG_ID, "invoice", {
      moveType: "out_invoice", partnerId: null, invoiceDate: null, ref: null, lines: [], extra: {}, linkKind: null,
    });
    await svc.pushNote(CREDS, "tw-8", { userInitiated: true });
    const invoice = (await db.findNoteLink("tw-8", CONFIG_ID, "account.move", "create"))!;
    server.edit("account.move", invoice.resId, { narration: "<p><b>Bill 2</b></p><p>Net 30</p>" });

    await svc.syncAll(CREDS);
    const deal = (await db.getNoteById("tw-7"))!;
    expect(deal.title).toBe("Deal 2");
    expect(await tagNames(deal.tags)).toEqual(["hot"]);
    const bill = (await db.getNoteById("tw-8"))!;
    expect(bill.title).toBe("Bill 2");
    expect(bill.entries.map((e) => (e.params as any).text)).toEqual(["Net 30"]);
  });

  it("brings back an activity's summary, note and deadline, and its archiving as done", async () => {
    const server = odoo();
    vi.stubGlobal("fetch", server.fetchMock);
    await db.addNote(makeNote({ id: "tw-9", title: "Call" }));
    await svc.setActivity("tw-9", CONFIG_ID, {
      resModel: "res.partner", resId: 5, typeId: null, deadline: "2026-11-02", userId: null,
    });
    await svc.pushNote(CREDS, "tw-9", { userInitiated: true });
    const link = (await db.getNoteLinks("tw-9")).find((l) => l.kind === "activity")!;
    expect(link.params!.base.remote.date).toBe("2026-11-02");
    server.edit("mail.activity", link.resId, { summary: "Call back", date_deadline: "2026-11-09" });
    await svc.syncAll(CREDS);
    const n = (await db.getNoteById("tw-9"))!;
    expect(n.title).toBe("Call back");
    const date = n.entries.find((e) => e.type === "date");
    expect(new Date((date!.params as any).date).getDate()).toBe(9);
    server.edit("mail.activity", link.resId, { active: false });
    await svc.syncAll(CREDS);
    expect((await db.getNoteLinks("tw-9")).find((l) => l.kind === "activity")!.remoteState).toBe("done");
  });

  it("keeps one pull cursor per model, so a record written during another model's pull is not skipped", async () => {
    const server = odoo();
    const task = await sentTask(server, "tw-11");
    await db.addNote(makeNote({ id: "tw-12", title: "Deal" }));
    await svc.setTarget("tw-12", CONFIG_ID, "lead", { partnerId: null });
    await svc.pushNote(CREDS, "tw-12", { userInitiated: true });
    const lead = (await db.findNoteLink("tw-12", CONFIG_ID, "crm.lead", "create"))!;
    await svc.syncAll(CREDS);
    server.edit("project.task", task.resId, { name: "Moved on" });
    await svc.syncAll(CREDS);
    // Written while the task was read, with a write_date before the task's cursor
    server.edit("crm.lead", lead.resId, { name: "Deal 2" });
    const taskStamp: string = server.records["project.task"].get(task.resId).write_date;
    server.records["crm.lead"].get(lead.resId).write_date = taskStamp.replace(/(\d\d)$/, (n) => `${String(Number(n) - 1).padStart(2, "0")}.5`);
    await svc.syncAll(CREDS);
    expect((await db.getNoteById("tw-12"))!.title).toBe("Deal 2");
  });

  it("sends a tag's name, not the app's id of it", async () => {
    const server = odoo();
    await db.addTag({ id: "tag-uuid-1", name: "urgent", color: "#000" });
    const link = await sentTask(server, "tw-13", { tags: ["tag-uuid-1"] });
    const names = server.records["project.task"].get(link.resId).tag_ids.map((id: number) => server.tags["project.tags"].get(id));
    expect(names).toEqual(["urgent"]);
  });

  it("writes a task's date so it reads back as the same day, and clears an opportunity's", async () => {
    const server = odoo();
    const evening = new Date(2026, 10, 5, 21, 30).toISOString();
    const link = await sentTask(server, "tw-14", { entries: [{ id: "d", type: "date", params: { date: evening } } as any] });
    const sentDate: string = server.records["project.task"].get(link.resId).date_deadline;
    expect(sentDate).toBe(evening.slice(0, 19).replace("T", " "));
    server.fetchMock.mockClear();
    await svc.syncAll(CREDS);
    const date = (await db.getNoteById("tw-14"))!.entries.find((e) => e.type === "date")!;
    expect((date.params as any).date).toBe(evening);

    await db.addNote(makeNote({ id: "tw-15", entries: [{ id: "d", type: "date", params: { date: evening } } as any] }));
    await svc.setTarget("tw-15", CONFIG_ID, "lead", { partnerId: null });
    await svc.pushNote(CREDS, "tw-15", { userInitiated: true });
    const lead = (await db.findNoteLink("tw-15", CONFIG_ID, "crm.lead", "create"))!;
    await db.updateNote("tw-15", { ...(await db.getNoteById("tw-15"))!, entries: [] });
    await db.setNotePerServerStatus("tw-15", CONFIG_ID, "pending");
    await svc.pushNote(CREDS, "tw-15");
    expect(server.records["crm.lead"].get(lead.resId).date_deadline).toBe(false);
    await svc.syncAll(CREDS);
    expect((await db.getNoteById("tw-15"))!.entries).toEqual([]);
  });

  it("never sends an activity's deadline, and does not stay pending for it", async () => {
    const server = odoo();
    vi.stubGlobal("fetch", server.fetchMock);
    await db.addNote(makeNote({ id: "tw-16", entries: [{ id: "d", type: "date", params: { date: new Date(2026, 10, 5, 9).toISOString() } } as any] }));
    await svc.setActivity("tw-16", CONFIG_ID, { resModel: "res.partner", resId: 5, typeId: null, deadline: "2026-11-02", userId: null });
    await svc.pushNote(CREDS, "tw-16", { userInitiated: true });
    await svc.syncAll(CREDS);
    expect((await db.getNotePerServerStatus("tw-16"))[CONFIG_ID]).toBe("synced");
    expect(await svc.hasDueWork(CONFIG_ID)).toBe(false);
    await db.updateNote("tw-16", { ...(await db.getNoteById("tw-16"))!, entries: [] });
    await db.setNotePerServerStatus("tw-16", CONFIG_ID, "pending");
    server.fetchMock.mockClear();
    await svc.syncAll(CREDS);
    for (const values of writes(server.fetchMock, "mail.activity")) expect(values).not.toHaveProperty("date_deadline");
    // The note's date changed, the activity's deadline did not: nothing left to send
    expect((await db.getNotePerServerStatus("tw-16"))[CONFIG_ID]).toBe("synced");
    // And a deadline moved on the server while the note's date changed is no conflict
    const link = (await db.getNoteLinks("tw-16")).find((l) => l.kind === "activity")!;
    server.edit("mail.activity", link.resId, { date_deadline: "2026-11-20" });
    await db.updateNote("tw-16", { ...(await db.getNoteById("tw-16"))!, entries: [
      { id: "d2", type: "date", params: { date: new Date(2026, 10, 12, 9).toISOString() } } as any,
    ] });
    await db.setNotePerServerStatus("tw-16", CONFIG_ID, "pending");
    await svc.syncAll(CREDS);
    // The deadline only comes back: the server's wins over the note's date
    expect(new Date(((await db.getNoteById("tw-16"))!.entries[0].params as any).date).getDate()).toBe(20);
    expect(await svc.conflictsOf("tw-16")).toEqual([]);
  });

  it("does not take an activity's deadline as a server change on a link with no base", async () => {
    const server = odoo();
    vi.stubGlobal("fetch", server.fetchMock);
    const day = new Date(2026, 10, 5, 9).toISOString();
    server.records["mail.activity"].set(60, { id: 60, summary: "Call", note: "", date_deadline: "2026-11-02", active: true, write_date: "2099-01-01 00:00:00" });
    await db.addNote(makeNote({ id: "tw-17", title: "Call", entries: [{ id: "d", type: "date", params: { date: day } } as any] }));
    await db.addNoteLink({
      id: "lk-17", noteId: "tw-17", configId: CONFIG_ID, model: "mail.activity", resId: 60, kind: "activity",
      remoteState: "ok", createdAt: "2026-01-01T00:00:00.000Z", lastSyncedAt: "2026-01-01T00:00:00.000Z",
    });
    await svc.syncAll(CREDS);
    expect(((await db.getNoteById("tw-17"))!.entries[0].params as any).date).toBe(day);
  });

  it("keeps the note in conflict while a link holds one, whatever writes the server's status", async () => {
    const server = odoo();
    const link = await sentTask(server, "tw-18");
    server.edit("project.task", link.resId, { name: "Theirs" });
    await db.updateNote("tw-18", { ...(await db.getNoteById("tw-18"))!, title: "Mine" });
    await db.setNotePerServerStatus("tw-18", CONFIG_ID, "pending");
    const result = await svc.syncAll(CREDS);
    expect(result.errors).toEqual([]);
    expect((await db.getNoteSyncInfo("tw-18")).syncStatus).toBe("conflict");
    // An edit, or another record's push, writes "pending" or "synced" there
    await db.setNotePerServerStatus("tw-18", CONFIG_ID, "synced");
    expect(await db.refreshNoteSyncStatus("tw-18")).toBe("conflict");
  });

  it("writes a media change alone, and a date change does not touch the text", async () => {
    const server = odoo();
    const link = await sentTask(server, "tw-19");
    await db.updateNote("tw-19", { ...(await db.getNoteById("tw-19"))!, entries: [
      ...(await db.getNoteById("tw-19"))!.entries, { id: "p", type: "photo", params: { path: "p.jpg" } } as any,
    ] });
    await db.setNotePerServerStatus("tw-19", CONFIG_ID, "pending");
    server.fetchMock.mockClear();
    await svc.pushNote(CREDS, "tw-19");
    expect(Object.keys(writes(server.fetchMock, "project.task")[0])).toEqual(["description"]);
    // The server changes the text while the app changes the date: no conflict
    server.edit("project.task", link.resId, { description: server.records["project.task"].get(link.resId).description.replace("First", "Edited") });
    await db.updateNote("tw-19", { ...(await db.getNoteById("tw-19"))!, entries: [
      { id: "d", type: "date", params: { date: new Date(2026, 10, 5, 9).toISOString() } } as any,
      ...(await db.getNoteById("tw-19"))!.entries,
    ] });
    await db.setNotePerServerStatus("tw-19", CONFIG_ID, "pending");
    await svc.pushNote(CREDS, "tw-19", { userInitiated: true });
    expect(await svc.conflictsOf("tw-19")).toEqual([]);
    expect((await db.getNoteById("tw-19"))!.entries.some((e) => e.type === "text" && (e.params as any).text === "Edited")).toBe(true);
  });

  it("applies the server's values to a link sent before bases existed, then keeps a base", async () => {
    const server = odoo();
    vi.stubGlobal("fetch", server.fetchMock);
    server.records["project.task"].set(50, { id: 50, name: "Server", description: "<p>Body</p>", tag_ids: [], active: true, state: "01_in_progress", write_date: "2099-01-01 00:00:00" });
    await db.addNote(makeNote({ id: "tw-10", title: "Old" }));
    await linkTask(db, "tw-10", 50);
    await svc.syncAll(CREDS);
    expect((await db.getNoteById("tw-10"))!.title).toBe("Server");
    expect((await db.findNoteLink("tw-10", CONFIG_ID, "project.task", "create"))!.params!.base).toBeTruthy();
  });
});

describe("SyncService — companies", () => {
  let svc: SyncService;
  let db: DatabaseService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await prepareSyncDb(db);
    await db.addParamsToNoteLinks();
    svc = new SyncService(db);
    await SecureStoragePlugin.set({
      key: syncSessionKey(CREDS),
      value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 17 }),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  /** Server whose user works in companies 1 (current) and 2, or only 1. */
  function server(companies: number[] = [1, 2]) {
    return routeFetch((url, body) => {
      if (url.endsWith("/web/session/get_session_info")) {
        return { result: {
          uid: 2,
          user_companies: {
            current_company: 1,
            allowed_companies: Object.fromEntries(companies.map((id) => [id, { id, name: `Company ${id}` }])),
          },
        } };
      }
      const { method } = body.params as any;
      if (method === "create") return { result: 900 };
      return { result: method === "search_read" ? [] : true };
    });
  }

  it("reads the user's companies, current first, and keeps them for offline", async () => {
    vi.stubGlobal("fetch", server([2, 1]));
    expect(await svc.serverCompanies(CREDS, { online: true })).toEqual({
      companies: [{ id: 1, name: "Company 1" }, { id: 2, name: "Company 2" }], last: null,
    });
    vi.stubGlobal("fetch", routeFetch(() => { throw new TypeError("Failed to fetch"); }));
    expect((await new SyncService(db).serverCompanies(CREDS, { online: false })).companies).toHaveLength(2);
  });

  it("makes every call in the user's companies, and a creation in the one chosen first", async () => {
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.serverCompanies(CREDS, { online: true });
    await db.addNote(makeNote({ id: "co-1" }));
    await svc.setTarget("co-1", CONFIG_ID, "task", { projectId: null });
    await svc.setCreationCompany("co-1", CONFIG_ID, 2);
    await svc.pushNote(CREDS, "co-1", { userInitiated: true });
    const create = rpcCalls(fetchMock).find((c) => (c.body.params as any).method === "create")!;
    expect((create.body.params as any).kwargs.context.allowed_company_ids).toEqual([2, 1]);
    const others = rpcCalls(fetchMock).filter((c) => c.body.params.model && (c.body.params as any).method !== "create");
    for (const c of others) expect((c.body.params as any).kwargs.context?.allowed_company_ids).toEqual([1, 2]);
    expect((await svc.serverCompanies(CREDS, { online: false })).last).toBe(2);
  });

  it("reads the kept companies again once per run, dropping one the user lost", async () => {
    vi.stubGlobal("fetch", server([1, 2, 3]));
    await svc.serverCompanies(CREDS, { online: true });
    const fresh = new SyncService(db);
    const fetchMock = server([1, 2]);
    vi.stubGlobal("fetch", fetchMock);
    await db.addNote(makeNote({ id: "co-3" }));
    await linkTask(db, "co-3", 10);
    await fresh.pushNote(CREDS, "co-3");
    const write = rpcCalls(fetchMock).find((c) => (c.body.params as any).method === "write")!;
    expect((write.body.params as any).kwargs.context.allowed_company_ids).toEqual([1, 2]);
  });

  it("creates in the server's last chosen company a record queued before the choice", async () => {
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.serverCompanies(CREDS, { online: true });
    await db.addNote(makeNote({ id: "co-4" }));
    await svc.setCreationCompany("co-4", CONFIG_ID, 2);
    await svc.setTarget("co-4", CONFIG_ID, "task", { projectId: null });
    await svc.pushNote(CREDS, "co-4", { userInitiated: true });
    const create = rpcCalls(fetchMock).find((c) => (c.body.params as any).method === "create")!;
    expect((create.body.params as any).kwargs.context.allowed_company_ids).toEqual([2, 1]);
  });

  it("tells after each push and sync that statuses may have changed", async () => {
    vi.stubGlobal("fetch", server([1]));
    const after = vi.fn();
    svc.onAfterSync = after;
    await db.addNote(makeNote({ id: "co-5" }));
    await svc.pushNote(CREDS, "co-5", { userInitiated: true }).catch(() => {});
    await svc.syncAll(CREDS);
    expect(after).toHaveBeenCalledTimes(2);
  });

  it("adds no company context for a user of one company", async () => {
    const fetchMock = server([1]);
    vi.stubGlobal("fetch", fetchMock);
    await svc.serverCompanies(CREDS, { online: true });
    await db.addNote(makeNote({ id: "co-2" }));
    await svc.setTarget("co-2", CONFIG_ID, "task", { projectId: null });
    await svc.pushNote(CREDS, "co-2", { userInitiated: true });
    for (const c of rpcCalls(fetchMock).filter((c) => c.body.params.model)) {
      expect((c.body.params as any).kwargs?.context?.allowed_company_ids).toBeUndefined();
    }
  });
});

describe("SyncService — attachments", () => {
  let svc: SyncService;
  let db: DatabaseService;
  let storage: Map<string, string>;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    storage = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, String(v)); },
      removeItem: (k: string) => { storage.delete(k); },
    });
    db = new DatabaseService();
    await db.initialize();
    await prepareSyncDb(db);
    await db.addParamsToNoteLinks();
    svc = new SyncService(db);
    svc.attachmentIO = { size: async () => 1000, read: async () => "QUJD", onWifi: async () => true };
    await SecureStoragePlugin.set({
      key: syncSessionKey(CREDS),
      value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 17 }),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  function server(options: { attachmentError?: boolean; refuse?: string; lost?: string; found?: number } = {}) {
    let next = 300;
    return routeFetch((url, body) => {
      if (url.endsWith("/mail/message/update_content")) return { result: {} };
      const { model, method, args } = body.params as any;
      const kwargs = (body.params as any).kwargs ?? {};
      if (model === "ir.attachment" && method === "search_read") return { result: options.found ? [{ id: options.found }] : [] };
      if (model === "ir.attachment" && method === "create") {
        if (options.attachmentError || args[0].name === options.refuse) {
          return { error: { code: 200, message: "x", data: { name: "odoo.exceptions.AccessError", message: "no" } } };
        }
        if (args[0].name === options.lost) throw new TypeError("Failed to fetch");
        return { result: next++ };
      }
      if (method === "fields_get") return { result: { message_ids: {} } };
      if (model === "mail.message" && method === "search_read" && kwargs.domain?.[0]?.[0] === "id") {
        return { result: [{ id: kwargs.domain[0][2], body: "<p>x</p>", attachment_ids: [7] }] };
      }
      // The record checks find what they look for; the task is not read back, so a push writes it whole
      const recordCheck = kwargs.fields?.length === 1 && kwargs.fields[0] === "id";
      if (method === "search_read" && kwargs.domain?.[0]?.[0] === "id" && (model !== "project.task" || recordCheck)) {
        return { result: [{ id: kwargs.domain[0][2] }] };
      }
      if (method === "message_post") return { result: 600 };
      if (method === "create") return { result: 900 };
      return { result: method === "search_read" ? [] : true };
    });
  }

  const photo = (id = "p1") => ({ id, type: "photo", params: { path: `file:///data/${id}.jpg` } } as any);
  const attachments = (fetchMock: ReturnType<typeof routeFetch>) =>
    rpcCalls(fetchMock).filter((c) => c.body.params.model === "ir.attachment" && c.body.params.method === "create")
      .map((c) => c.body.params.args![0]);

  it("sends a new task's photos to it once, then a photo added later", async () => {
    await db.addNote(makeNote({ id: "at-1", entries: [photo("p1")] }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.setTarget("at-1", CONFIG_ID, "task", { projectId: null });
    await svc.pushNote(CREDS, "at-1", { userInitiated: true });
    expect(attachments(fetchMock)).toEqual([{ name: "p1.jpg", datas: "QUJD", res_model: "project.task", res_id: 900, mimetype: "image/jpeg" }]);
    const link = (await db.findNoteLink("at-1", CONFIG_ID, "project.task", "create"))!;
    expect(link.params!.attachments).toEqual({ p1: { id: 300, path: "file:///data/p1.jpg" } });

    await db.updateNote("at-1", makeNote({ id: "at-1", entries: [photo("p1"), photo("p2")] }));
    fetchMock.mockClear();
    await svc.pushNote(CREDS, "at-1");
    expect(attachments(fetchMock).map((a) => a.name)).toEqual(["p2.jpg"]);
  });

  it("holds the files for Wi-Fi, and leaves out one over the size limit", async () => {
    storage.set("options.sync.attachments", JSON.stringify({ wifiOnly: true, maxMb: 1 }));
    svc.attachmentIO = { size: async (p) => (p.includes("big") ? 5 * 1024 * 1024 : 10), read: async () => "QUJD", onWifi: async () => false };
    await db.addNote(makeNote({ id: "at-2", entries: [photo("small"), photo("big")] }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.setTarget("at-2", CONFIG_ID, "task", { projectId: null });
    await svc.pushNote(CREDS, "at-2", { userInitiated: true });
    expect(attachments(fetchMock)).toEqual([]);

    svc.attachmentIO = { ...svc.attachmentIO, onWifi: async () => true };
    await db.updateNote("at-2", makeNote({ id: "at-2", title: "Wifi now", entries: [photo("small"), photo("big")] }));
    await svc.pushNote(CREDS, "at-2");
    expect(attachments(fetchMock).map((a) => a.name)).toEqual(["small.jpg"]);
    const link = (await db.findNoteLink("at-2", CONFIG_ID, "project.task", "create"))!;
    expect(link.params!.attachmentsSkipped).toEqual({ big: 5 * 1024 * 1024 });
  });

  it("adds a message's files to it, beside those it has", async () => {
    await db.addNote(makeNote({ id: "at-3", entries: [photo("p1")] }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.setMessage("at-3", CONFIG_ID, { resModel: "crm.lead", resId: 7, typeId: null, deadline: null, userId: null });
    await svc.pushNote(CREDS, "at-3", { userInitiated: true });
    expect(attachments(fetchMock)[0]).toMatchObject({ res_model: "crm.lead", res_id: 7 });
    const edit = rpcCalls(fetchMock).find((c) => c.url.endsWith("/mail/message/update_content"))!;
    expect(edit.body.params).toMatchObject({ message_id: 600, attachment_ids: [7, 300] });
  });

  it("sends a replaced photo again, and reuses a file sent to the same record by another link", async () => {
    await db.addNote(makeNote({ id: "at-5", entries: [photo("p1")] }));
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.setTarget("at-5", CONFIG_ID, "task", { projectId: null });
    await svc.pushNote(CREDS, "at-5", { userInitiated: true });
    // A message posted on the note's own task: the photo is there already
    await svc.setMessage("at-5", CONFIG_ID, { resModel: "project.task", resId: 900, typeId: null, deadline: null, userId: null });
    fetchMock.mockClear();
    await svc.pushNote(CREDS, "at-5", { userInitiated: true });
    expect(attachments(fetchMock)).toEqual([]);
    const edit = rpcCalls(fetchMock).find((c) => c.url.endsWith("/mail/message/update_content"))!;
    expect(edit.body.params).toMatchObject({ attachment_ids: [7, 300] });

    await db.updateNote("at-5", makeNote({ id: "at-5", entries: [{ id: "p1", type: "photo", params: { path: "file:///data/retake.jpg" } } as any] }));
    fetchMock.mockClear();
    await svc.pushNote(CREDS, "at-5");
    expect(attachments(fetchMock).map((a) => [a.name, a.res_model])).toContainEqual(["retake.jpg", "project.task"]);
  });

  it("goes on past a file the server refuses, and keeps waiting for Wi-Fi as pending", async () => {
    await db.addNote(makeNote({ id: "at-6", entries: [photo("bad"), photo("good")] }));
    const fetchMock = server({ refuse: "bad.jpg" });
    vi.stubGlobal("fetch", fetchMock);
    await svc.setTarget("at-6", CONFIG_ID, "task", { projectId: null });
    await svc.pushNote(CREDS, "at-6", { userInitiated: true });
    const link = (await db.findNoteLink("at-6", CONFIG_ID, "project.task", "create"))!;
    expect(Object.keys(link.params!.attachments)).toEqual(["good"]);
    expect(link.params!.attachmentsSkipped).toEqual({ bad: "refused" });
    expect((await db.getNotePerServerStatus("at-6"))[CONFIG_ID]).toBe("synced");

    storage.set("options.sync.attachments", JSON.stringify({ wifiOnly: true, maxMb: null }));
    svc.attachmentIO = { ...svc.attachmentIO, onWifi: async () => false };
    await db.updateNote("at-6", makeNote({ id: "at-6", entries: [photo("bad"), photo("good"), photo("new")] }));
    await db.setNotePerServerStatus("at-6", CONFIG_ID, "pending");
    await svc.pushNote(CREDS, "at-6");
    expect((await db.getNotePerServerStatus("at-6"))[CONFIG_ID]).toBe("pending");
  });

  it("looks for a file whose create got no answer before sending it again", async () => {
    await db.addNote(makeNote({ id: "at-7", entries: [photo("p1")] }));
    vi.stubGlobal("fetch", server({ lost: "p1.jpg" }));
    await svc.setTarget("at-7", CONFIG_ID, "task", { projectId: null });
    await svc.pushNote(CREDS, "at-7", { userInitiated: true });
    expect((await db.getNotePerServerStatus("at-7"))[CONFIG_ID]).toBe("pending");
    const fetchMock = server({ found: 444 });
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "at-7");
    expect(attachments(fetchMock)).toEqual([]);
    const link = (await db.findNoteLink("at-7", CONFIG_ID, "project.task", "create"))!;
    expect(link.params!.attachments.p1.id).toBe(444);
  });

  it("never fails the push for a file the server refuses, keeping the reason", async () => {
    await db.addNote(makeNote({ id: "at-4", entries: [photo("p1")] }));
    vi.stubGlobal("fetch", server({ attachmentError: true }));
    await svc.setTarget("at-4", CONFIG_ID, "task", { projectId: null });
    await expect(svc.pushNote(CREDS, "at-4", { userInitiated: true })).resolves.toBeUndefined();
    const link = (await db.findNoteLink("at-4", CONFIG_ID, "project.task", "create"))!;
    expect(link.params!.attachmentError).toContain("no");
    expect(link.params!.attachments).toEqual({});
    expect(link.params!.attachmentsSkipped).toEqual({ p1: "refused" });
  });
});
