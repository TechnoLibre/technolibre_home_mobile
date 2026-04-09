import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "../services/databaseService";
import { SyncService, SyncCredentials } from "../services/syncService";
import { Note, NoteEntry } from "../models/note";

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

function mockFetch(responseBody: object, status = 200) {
  // The CapacitorHttp mock in @capacitor/core delegates to fetch,
  // then parses the body as JSON. So we still mock global.fetch here.
  const bodyText = JSON.stringify(responseBody);
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => bodyText,
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
    await db.addSyncColumnsToNotes();
    svc = new SyncService(db);
    // Pre-store a session so authenticate is not called
    await SecureStoragePlugin.set({
      key: `odoo_sync_session_${btoa(`${CREDS.odooUrl}|${CREDS.username}`)}`,
      value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 18 }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls project.task.create on first push and stores odoo_id", async () => {
    const note = makeNote({ id: "note-1", title: "My Note" });
    await db.addNote(note);

    vi.stubGlobal("fetch", mockFetch({ result: 42 }));

    await svc.pushNote(CREDS, "note-1");

    const info = await db.getNoteSyncInfo("note-1");
    expect(info.odooId).toBe(42);
    expect(info.odooUrl).toBe(CREDS.odooUrl);
    expect(info.syncStatus).toBe("synced");
    expect(info.lastSyncedAt).not.toBeNull();
  });

  it("calls project.task.write on subsequent push (odoo_id already set)", async () => {
    const note = makeNote({ id: "note-2", title: "Existing" });
    await db.addNote(note);
    await db.setNoteSyncInfo("note-2", { odooId: 99, odooUrl: CREDS.odooUrl, syncStatus: "synced" });

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

  it("maps done=true to state='done'", async () => {
    const note = makeNote({ id: "note-6", done: true });
    await db.addNote(note);

    const fetchMock = mockFetch({ result: 66 });
    vi.stubGlobal("fetch", fetchMock);

    await svc.pushNote(CREDS, "note-6");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.params.args[0].state).toBe("done");
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
      key: `odoo_sync_session_${btoa(`${CREDS.odooUrl}|${CREDS.username}`)}`,
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
    await db.addSyncColumnsToNotes();
    svc = new SyncService(db);
    await SecureStoragePlugin.set({
      key: `odoo_sync_session_${btoa(`${CREDS.odooUrl}|${CREDS.username}`)}`,
      value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 18 }),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("updates title and pinned from Odoo task", async () => {
    const note = makeNote({ id: "pull-1", title: "Old Title", pinned: false });
    await db.addNote(note);
    await db.setNoteSyncInfo("pull-1", { odooId: 10, odooUrl: CREDS.odooUrl, syncStatus: "synced" });

    vi.stubGlobal("fetch", mockFetch({
      result: [{ id: 10, name: "New Title", priority: "1", active: true, tag_ids: [], date_deadline: null, write_date: "2026-04-10" }],
    }));

    const updated = await svc.pullNotes(CREDS, new Date(0));
    expect(updated).toBe(1);

    const refreshed = await db.getNoteById("pull-1");
    expect(refreshed!.title).toBe("New Title");
    expect(refreshed!.pinned).toBe(true);
  });

  it("skips tasks not matched by odoo_id", async () => {
    const note = makeNote({ id: "pull-2", title: "Local" });
    await db.addNote(note);
    await db.setNoteSyncInfo("pull-2", { odooId: 99, odooUrl: CREDS.odooUrl });

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
    await db.setNoteSyncInfo("pull-3", { odooId: 20, odooUrl: CREDS.odooUrl });

    vi.stubGlobal("fetch", mockFetch({
      result: [{ id: 20, name: "Test note", priority: "0", active: false, tag_ids: [], write_date: "2026-04-10" }],
    }));

    await svc.pullNotes(CREDS, new Date(0));
    const refreshed = await db.getNoteById("pull-3");
    expect(refreshed!.archived).toBe(true);
  });

  it("sets done from state=done on Odoo 17+", async () => {
    SecureStoragePlugin._store.clear();
    await SecureStoragePlugin.set({
      key: `odoo_sync_session_${btoa(`${CREDS.odooUrl}|${CREDS.username}`)}`,
      value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 17 }),
    });

    const note = makeNote({ id: "pull-4", done: false });
    await db.addNote(note);
    await db.setNoteSyncInfo("pull-4", { odooId: 30, odooUrl: CREDS.odooUrl });

    vi.stubGlobal("fetch", mockFetch({
      result: [{ id: 30, name: "Test note", priority: "0", active: true, state: "done", tag_ids: [], write_date: "2026-04-10" }],
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

// ─── SyncService — syncAll ────────────────────────────────────────────────────

describe("SyncService.syncAll", () => {
  let svc: SyncService;
  let db: DatabaseService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await db.addSyncColumnsToNotes();
    await db.addSyncConfigIdColumn();
    svc = new SyncService(db);
    await SecureStoragePlugin.set({
      key: `odoo_sync_session_${btoa(`${CREDS.odooUrl}|${CREDS.username}`)}`,
      value: JSON.stringify({ sessionId: "fake-session", odooMajorVersion: 18 }),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("pushes pending notes and returns pushed count", async () => {
    const note = makeNote({ id: "sa-1", title: "Pending" });
    await db.addNote(note);
    await db.setNoteSyncInfo("sa-1", { syncStatus: "pending", odooUrl: CREDS.odooUrl });

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
    await db.setNoteSyncInfo("sa-2", { syncStatus: "synced", odooUrl: CREDS.odooUrl });

    vi.stubGlobal("fetch", mockFetch({ result: [] }));

    const result = await svc.syncAll(CREDS);
    expect(result.pushed).toBe(0);
  });

  it("records error when a push fails and continues", async () => {
    await db.addNote(makeNote({ id: "sa-3", title: "Fail" }));
    await db.setNoteSyncInfo("sa-3", { syncStatus: "pending", odooUrl: CREDS.odooUrl });
    await db.addNote(makeNote({ id: "sa-4", title: "Ok" }));
    await db.setNoteSyncInfo("sa-4", { syncStatus: "pending", odooUrl: CREDS.odooUrl });

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
    await db.setNoteSyncInfo("sa-5", { syncStatus: "pending", syncConfigId: configId });
    await db.addNote(makeNote({ id: "sa-6" }));
    await db.setNoteSyncInfo("sa-6", { syncStatus: "pending", odooUrl: CREDS.odooUrl });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ result: 5 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ result: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await svc.syncAll(CREDS, configId);
    expect(result.pushed).toBe(1);
  });
});
