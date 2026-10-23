import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "../services/databaseService";
import {
  SyncService, SyncCredentials, syncSessionKey, syncConfigIdOf, RemoteRecordDeletedError,
  TASK_CREATE, LEAD_CREATE, ACTIVITY_CREATE, clientMarker,
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
    expect(methods).toEqual(["create", "write"]);
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

  it("sends active on create only, and date_deadline only for a note with a date", async () => {
    await db.addNote(makeNote({ id: "ld-18", archived: false }));
    await linkLead("ld-18", 70);
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "ld-18");
    const values = sent(fetchMock, "crm.lead", "write")[0].body.params.args![1];
    expect(values).not.toHaveProperty("active");
    expect(values).not.toHaveProperty("date_deadline");
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
      const { model, method } = body.params as any;
      const kwargs = (body.params as any).kwargs ?? {};
      if (method === "fields_get") {
        return { result: options.noActivities?.includes(model) ? { name: {} } : { name: {}, activity_ids: {} } };
      }
      if (model === "mail.activity" && method === "search_read" && kwargs.domain?.[0]?.[0] === "id") {
        const id = kwargs.domain[0][2];
        return { result: id >= 500 ? [{ id, active: !(options.archived ?? []).includes(id) }] : [] };
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
    for (const key of ["activity_type_id", "date_deadline", "user_id"]) expect(values).not.toHaveProperty(key);
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
    expect(Object.keys(values).sort()).toEqual(["note", "summary"]);
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
    expect((read.body.params as any).kwargs).toMatchObject({ fields: ["active"], context: { active_test: false } });
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
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    await svc.pushNote(CREDS, "ac-26");
    expect(sent(fetchMock, "mail.activity", "search_read")).toHaveLength(0);
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
    await svc.dropActivity("ac-16", op.id);
    expect(await db.getOutboxOp(op.id)).not.toBeNull();
    await svc.dropActivity("ac-15", op.id);
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
