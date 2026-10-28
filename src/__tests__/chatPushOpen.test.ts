// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { allowedOpenUrl, listeningOf, openFromPush, reasonText, threadOfUrl, wirePushOpen } from "../services/chat/chatPushOpen";
import { fakeChatPushNative } from "../__mocks__/chatPushNative";
import type { PushHealth } from "../plugins/chatPushPlugin";
import type { ChatPushRow } from "../models/chat";

// The cases of ChatPushOpenTest (Java), replayed: both sides apply one rule.
const ID = "https%3A%2F%2Fodoo.exemple.test%7Calice%7Cdemo";
const A = "https://odoo.exemple.test|alice|demo";

beforeEach(() => {
  const store: Record<string, string> = { app_lang: "en" };
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("allowedOpenUrl", () => {
  it("the three paths pass", () => {
    for (const u of [
      "/chat",
      `/chat/${ID}/42`,
      `/chat/inbox?s=${ID}&thread=project.task,7`,
      `/chat/inbox?s=${ID}&thread=res.partner,12`,
      "/chat/http%3A%2F%2Fodoo.exemple.test%3A8069%7C%7Cdemo/42",
      "/chat/https%3A%2F%2Fodoo.exemple.test%7Calice%20martin%7Cdemo/42",
      "/chat/https%3A%2F%2Fodoo.exemple.test%3A8443%2Fodoo%7Cbob%20martin%7Cdb_1/42",
      `/chat/${encodeURIComponent("https://odoo.exemple.test|alice.martin@exemple.test|demo")}/42`,
    ]) expect(allowedOpenUrl(u), u).toBe(true);
  });

  it("anything else is refused", () => {
    for (const u of [
      null, undefined, "", "//evil", "//evil.exemple.test/chat", "/note/1", "javascript:alert(1)",
      "https://odoo.exemple.test/chat", "/chat/", "/chat\n", `/chat/${ID}/42/info`, `/chat/${ID}/x`,
      `/chat/inbox?s=${ID}&thread=project.task,7&x=1`, `/chat/inbox?s=${ID}&thread=Project/Task,7`,
      "/chat/inbox?s=&thread=project.task,7", `/chat/inbox?thread=project.task,7&s=${ID}`,
      `/chat/inbox?s=${ID}&thread=project.task,`,
    ]) expect(allowedOpenUrl(u as string), String(u)).toBe(false);
  });

  it("the configId is checked by its decoded shape", () => {
    for (const u of [
      "/chat/odoo.exemple.test%7Calice%7Cdemo/42",
      "/chat/inbox?s=upab12cd34&thread=project.task,7",
      "/chat/ftp%3A%2F%2Fodoo.exemple.test%7Calice%7Cdemo/42",
      "/chat/https%3A%2F%2Fodoo.exemple.test%7Calice%0A%7Cdemo/42",
      "/chat/https%3A%2F%2Fodoo.exemple.test%7Ca%09b%7Cdemo/42",
      "/chat/https%3A%2F%2Fodoo.exemple.test%7Calice%7Cdemo%20base/42",
      "/chat/https%3A%2F%2Fodoo%20exemple.test%7Calice%7Cdemo/42",
      "/chat/https%3A%2F%2Fodoo.exemple.test%7Calice%7Cdemo%7F/42",
      "/chat/../42", "/chat/%2E%2E/42", "/chat/inbox?s=%2E%2E&thread=project.task,7", "/chat/....../42",
      `/chat/${ID}%7Cx/42`,
      "/chat/https%3A%2F%2Fodoo.exemple.test%7Calice%7C/42",
      "/chat/https%3A%2F%2F%7Calice%7Cdemo/42",
      "/chat/https%3A//odoo.exemple.test%7Calice%7Cdemo/42",
      "/chat/https:%2F%2Fodoo.exemple.test%7Calice%7Cdemo/42",
      "/chat/https%3A%2F%2Fodoo.exemple.test%7Calice%7Cdem%2/42",
      "/chat/https%3A%2F%2Fodoo.exemple.test%7Calice%7Cdem%G1/42",
      "/chat/https%3A%2F%2Fodoo.exemple.test%7Ca%C3%28%7Cdemo/42",
      "/chat/https%3A%2F%2Fodoo.exemple.test%7Calice%0Amartin%7Cdemo/42",
      "/chat/https%3A%2F%2Fodoo.exemple.test%7Calice%7Cmartin%7Cdemo/42",
    ]) expect(allowedOpenUrl(u), u).toBe(false);
  });

  it("the decoded thread of a conversation url", () => {
    expect(threadOfUrl(`/chat/${ID}/42`)).toEqual({ configId: A, channelId: 42 });
    expect(threadOfUrl("/chat")).toBeNull();
    expect(threadOfUrl(`/chat/inbox?s=${ID}&thread=project.task,7`)).toBeNull();
  });
});

describe("opening from a tap", () => {
  it("a launch url opens the conversation and clears its notifications", async () => {
    const native = fakeChatPushNative();
    native.launchUrl = `/chat/${ID}/42`;
    const nav = vi.fn();
    await wirePushOpen(native, nav);
    expect(nav).toHaveBeenCalledWith(`/chat/${ID}/42`);
    expect(native.callsOf("clear")).toEqual([{ configId: A, channelId: 42 }]);
    // read once
    expect(native.launchUrl).toBeNull();
  });

  it("a tap while the app runs opens too", async () => {
    const native = fakeChatPushNative();
    const nav = vi.fn();
    const stop = await wirePushOpen(native, nav);
    native.emitPushOpen(`/chat/inbox?s=${ID}&thread=project.task,7`);
    expect(nav).toHaveBeenCalledWith(`/chat/inbox?s=${ID}&thread=project.task,7`);
    expect(native.callsOf("clear")).toEqual([]);
    stop();
    native.emitPushOpen("/chat");
    expect(nav).toHaveBeenCalledTimes(1);
  });

  it("a disallowed launch url is ignored", async () => {
    const native = fakeChatPushNative();
    native.launchUrl = "//evil.exemple.test/chat";
    const nav = vi.fn();
    await wirePushOpen(native, nav);
    native.emitPushOpen("/note/1");
    expect(nav).not.toHaveBeenCalled();
    expect(openFromPush("javascript:alert(1)", native, nav)).toBe(false);
    expect(native.callsOf("clear")).toEqual([]);
  });

  it("off a native platform nothing is wired", async () => {
    const nav = vi.fn();
    const stop = await wirePushOpen(null, nav);
    stop();
    expect(nav).not.toHaveBeenCalled();
  });
});

// A realtime build applies the level chosen: effectiveLevel follows level unless the case says otherwise
const health = (over: Partial<PushHealth> = {}): PushHealth => ({
  at: 0, level: 3, effectiveLevel: over.level ?? 3, mode: "poll_15", realtimeBuild: true, serviceAlive: true,
  ntfys: [], accounts: [], undecryptable: 0, faults: 0, notificationsAllowed: true, batteryExempt: true, ...over,
});
const row = (configId: string, ntfyUrl: string | null): ChatPushRow => ({
  configId, ntfyUrl, odooNtfyUrl: null, prefix: null, topic: null, endpoint: null, p256dh: null, auth: null,
  vapidKey: null, registeredAt: null, staleEndpoints: [], lockScreen: "hidden_locked",
});

describe("listeningOf", () => {
  it("level 5 is off whatever else is wrong", () => {
    const r = listeningOf(health({ level: 5, notificationsAllowed: false }), []);
    expect(r).toEqual({ off: true, alarms: [], warnings: [] });
  });

  it("a healthy phone has no alarm", () => {
    expect(listeningOf(health(), [])).toEqual({ off: false, alarms: [], warnings: [] });
  });

  it("a denied permission is an alarm", () => {
    expect(listeningOf(health({ notificationsAllowed: false }), []).alarms)
      .toEqual([{ configId: null, reason: "notifications_denied" }]);
  });

  it("a dead service is an alarm at levels 1 and 2 only", () => {
    expect(listeningOf(health({ level: 1, serviceAlive: false }), []).alarms)
      .toEqual([{ configId: null, reason: "service_dead" }]);
    expect(listeningOf(health({ level: 2, serviceAlive: false }), []).alarms).toHaveLength(1);
    expect(listeningOf(health({ level: 3, serviceAlive: false }), []).alarms).toEqual([]);
  });

  it("an account whose session expired, or with none, or in error is an alarm with its reason", () => {
    const acc = (state: any, reason: string | null) => ({ configId: A, via: "odoo" as const, state, reason, lastCheckAt: 0 });
    expect(listeningOf(health({ accounts: [acc("session_expired", null)] }), []).alarms)
      .toEqual([{ configId: A, reason: "session_expired" }]);
    expect(listeningOf(health({ accounts: [acc("no_session", null)] }), []).alarms)
      .toEqual([{ configId: A, reason: "no_session" }]);
    expect(listeningOf(health({ accounts: [acc("error", "odoo_unreachable")] }), []).alarms)
      .toEqual([{ configId: A, reason: "odoo_unreachable" }]);
    expect(listeningOf(health({ accounts: [acc("waiting", null), acc("ok", null)] }), []).alarms).toEqual([]);
  });

  it("an ntfy in error is an alarm for the account on it", () => {
    const ntfy = { url: "https://ntfy.exemple.test", state: "error" as const, reason: "unauthorized", lastContactAt: 0, configIds: [A] };
    expect(listeningOf(health({ ntfys: [ntfy] }), [row(A, "https://ntfy.exemple.test")]).alarms)
      .toEqual([{ configId: A, reason: "unauthorized" }]);
    expect(listeningOf(health({ ntfys: [{ ...ntfy, state: "connected", reason: null }] }), []).alarms).toEqual([]);
  });

  it("a build without the realtime service never reports it dead", () => {
    const r = listeningOf(health({ level: 1, effectiveLevel: 3, realtimeBuild: false, serviceAlive: false, batteryExempt: false }), []);
    expect(r).toEqual({ off: false, alarms: [], warnings: [] });
  });

  it("an Odoo-direct account Odoo does not answer says Odoo, not ntfy", () => {
    const acc = (via: "odoo" | "ntfy", reason: string | null) => ({ configId: A, via, state: "error" as const, reason, lastCheckAt: 0 });
    expect(listeningOf(health({ accounts: [acc("odoo", "unreachable")] }), []).alarms)
      .toEqual([{ configId: A, reason: "odoo_unreachable" }]);
    expect(listeningOf(health({ accounts: [acc("odoo", null)] }), []).alarms)
      .toEqual([{ configId: A, reason: "odoo_unreachable" }]);
    expect(listeningOf(health({ accounts: [acc("ntfy", "unreachable")] }), []).alarms)
      .toEqual([{ configId: A, reason: "unreachable" }]);
  });

  it("no battery exemption at levels 1 and 2 is a warning only", () => {
    const r = listeningOf(health({ level: 1, batteryExempt: false }), []);
    expect(r.alarms).toEqual([]);
    expect(r.warnings).toEqual(["battery_not_exempt"]);
    expect(listeningOf(health({ level: 3, batteryExempt: false }), []).warnings).toEqual([]);
  });
});

describe("reasonText", () => {
  it("words the http refusal and the blocked build differently", () => {
    expect(reasonText("http_refused")).not.toBe(reasonText("cleartext_blocked"));
    expect(reasonText("http_refused")).toBe("http not allowed");
    expect(reasonText("cleartext_blocked")).toContain("blocked");
    expect(reasonText("unauthorized")).toBe("token refused by ntfy");
    expect(reasonText("something_new")).toBe("unexpected answer");
  });
});
