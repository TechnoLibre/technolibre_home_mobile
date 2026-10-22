import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "../services/databaseService";
import { SyncService, SyncCredentials, syncSessionKey, syncConfigIdOf, RemoteRecordDeletedError } from "../services/syncService";
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

/** Schema a migrated install has for sync: columns + note_links. */
async function prepareSyncDb(db: DatabaseService, apps: SyncCredentials[] = [CREDS]): Promise<void> {
  await db.addSyncColumnsToNotes();
  await db.addSyncConfigIdColumn();
  await db.addSelectedSyncConfigIdsColumn();
  await db.addSyncPerServerStatusColumn();
  await db.addSyncFieldsToApplications();
  await db.addNtfyTokenColumn();
  await db.createNoteLinksTable();
  await db.createSyncPullCursorsTable();
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

  it("returns empty array when no changes", async () => {
    vi.stubGlobal("fetch", mockFetch({ result: [] }));
    const ids = await svc.pollForChanges(CREDS, new Date());
    expect(ids).toEqual([]);
  });

  it("returns Odoo IDs of changed tasks", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ result: [{ id: 10, write_date: "2026-03-30" }, { id: 20, write_date: "2026-03-30" }] })
    );
    const ids = await svc.pollForChanges(CREDS, new Date("2026-03-29"));
    expect(ids).toEqual([10, 20]);
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
      ["project_id", "=", false],
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

  it("retries a note whose push failed, on the next syncAll", async () => {
    await db.addNote(makeNote({ id: "pd-5" }));
    await db.markNotePendingForConfigs("pd-5", [CONFIG_ID]);

    vi.stubGlobal("fetch", routeFetch(() => ({ error: { code: 200, message: "502 Bad Gateway" } })));
    await svc.syncAll(CREDS);
    expect(await db.getNotePerServerStatus("pd-5")).toEqual({ [CONFIG_ID]: "error" });

    vi.stubGlobal("fetch", createThenEmptyPull());
    const result = await svc.syncAll(CREDS);
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
