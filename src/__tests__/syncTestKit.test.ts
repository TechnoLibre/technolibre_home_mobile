import { describe, it, expect, vi, afterEach } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { __setNetworkStatus, Network } from "@capacitor/network";
import {
	HARNESS_API, createSyncEnv, nodeTransport, installLocalStorage, memoryAttachmentIO, resetMocks,
	restartSyncEnv, setOnline, chatTitle,
} from "../testing/syncTestKit";
import { syncSessionKey } from "../services/syncService";
import { isHttpAllowed } from "../services/odoo/httpPolicy";

const TARGET = { url: "http://odoo.test:8069", username: "admin", password: "admin", database: "db1" };

describe("syncTestKit", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		resetMocks();
	});

	it("is at API 2", () => {
		expect(HARNESS_API).toBe(2);
	});

	it("builds a migrated database with one application per target and pushes a note through it", async () => {
		installLocalStorage({ allowHttp: true });
		const env = await createSyncEnv([TARGET, { ...TARGET, database: "db2" }]);
		expect(env.configIds).toEqual(["http://odoo.test:8069|admin|db1", "http://odoo.test:8069|admin|db2"]);
		expect((await env.db.getAllApplications()).map((a: any) => a.database)).toEqual(["db1", "db2"]);
		await SecureStoragePlugin.set({
			key: syncSessionKey(env.creds[0]),
			value: JSON.stringify({ sessionId: "s", odooMajorVersion: 17 }),
		});
		const calls: any[] = [];
		vi.stubGlobal("fetch", vi.fn(async (_url: string, opts: { body: string }) => {
			const body = JSON.parse(opts.body);
			calls.push(body.params);
			const result = body.params.method === "create" ? 42 : body.params.method === "search_read" ? [] : true;
			return { ok: true, status: 200, text: async () => JSON.stringify({ result }), headers: { forEach: () => {} } } as any;
		}));
		await env.db.addNote({ id: "n1", title: "Plan", done: false, archived: false, pinned: false, tags: [], entries: [] });
		await env.sync.setTarget("n1", env.configIds[0], "task", { projectId: null });
		await env.sync.pushNote(env.creds[0], "n1", { userInitiated: true });
		expect(calls.some((c) => c.model === "project.task" && c.method === "create")).toBe(true);
		expect((await env.db.findNoteLink("n1", env.configIds[0], "project.task", "create"))!.resId).toBe(42);
	});

	it("lets http through only when asked", () => {
		installLocalStorage();
		expect(isHttpAllowed()).toBe(false);
		installLocalStorage({ allowHttp: true });
		expect(isHttpAllowed()).toBe(true);
	});

	it("gives files from memory, a missing one as not found, and the Wi-Fi state set", async () => {
		const io = memoryAttachmentIO({ files: { "a.txt": "hé" }, wifi: false });
		expect(await io.size("a.txt")).toBe(3);
		expect(Buffer.from(await io.read("a.txt"), "base64").toString("utf8")).toBe("hé");
		expect(await io.size("gone.txt")).toBeNull();
		expect(await io.onWifi()).toBe(false);
		io.wifi = true;
		expect(await io.onWifi()).toBe(true);
	});

	it("forgets the sessions and puts the network back on Wi-Fi", async () => {
		await SecureStoragePlugin.set({ key: "k", value: "v" });
		__setNetworkStatus({ connected: false, connectionType: "none" });
		resetMocks();
		await expect(SecureStoragePlugin.get({ key: "k" })).rejects.toBeTruthy();
		expect(await Network.getStatus()).toEqual({ connected: true, connectionType: "wifi" });
	});

	describe("chat", () => {
		async function queued(chatModule?: "auto" | "ignore") {
			installLocalStorage({ allowHttp: true });
			const env = await createSyncEnv([TARGET], chatModule ? { chatModule } : undefined);
			const configId = env.configIds[0];
			await (env.chat as any).repo.setSourceState({ configId, moduleState: "installed" });
			env.chat.isOnline = async () => false;
			const src = { configId, creds: env.creds[0], label: "x", app: {} } as any;
			await env.chat.send(src, 7, "hello");
			return (await env.db.getOutboxOpsForConfig(configId)).filter((o: any) => o.params?.channelId === 7);
		}

		it("createSyncEnv exposes chat sharing the sync rpc and outbox", async () => {
			installLocalStorage({ allowHttp: true });
			const env = await createSyncEnv([TARGET]);
			expect(env.chat).toBe(env.sync.chat);
			expect((env.chat as any).rpc).toBe(env.sync.rpc);
			expect(env.chat.moduleMode).toBe("auto");
		});

		it("auto mode sends through the module when it is installed", async () => {
			expect((await queued())[0].params.useModule).toBe(true);
		});

		it("ignore mode never sends the uuid", async () => {
			expect((await queued("ignore"))[0].params.useModule).toBe(false);
		});

		it("ignore mode also turns off the module's create dedupe and member removal", async () => {
			installLocalStorage({ allowHttp: true });
			const env = await createSyncEnv([TARGET], { chatModule: "ignore" });
			const configId = env.configIds[0];
			await env.chat.repo.setSourceState({ configId, moduleState: "installed", isSystem: true });
			expect(await env.chat.features(configId)).toEqual({ canRemoveMembers: false, idempotentCreate: false });
		});

		it("setOnline is the network the chat reads", async () => {
			installLocalStorage({ allowHttp: true });
			const env = await createSyncEnv([TARGET]);
			setOnline(false);
			expect(await env.chat.isOnline()).toBe(false);
			setOnline(true);
			expect(await env.chat.isOnline()).toBe(true);
		});

		it("restartSyncEnv keeps the database and the queue, with a new chat service of the same mode", async () => {
			installLocalStorage({ allowHttp: true });
			const env = await createSyncEnv([TARGET], { chatModule: "ignore" });
			const configId = env.configIds[0];
			await env.chat.repo.setSourceState({ configId, selfPartnerId: 3 });
			setOnline(false);
			const src = { configId, creds: env.creds[0], label: "x", app: {} } as any;
			const { channelId } = await env.chat.createGroup(src, [7], "Team");
			await env.chat.send(src, channelId, "hello");

			const after = await restartSyncEnv(env);
			expect(after.db).toBe(env.db);
			expect(after.chat).not.toBe(env.chat);
			expect(after.chat).toBe(after.sync.chat);
			expect(after.chat.moduleMode).toBe("ignore");
			expect(await after.chat.isOnline()).toBe(false);
			expect((await after.db.getOutboxOpsForConfig(configId)).map((o: any) => o.kind).sort()).toEqual(["chat.create", "chat.post"]);
			expect(await after.chat.messages(configId, channelId)).toMatchObject([{ status: "pending" }]);
		});

		it("chatTitle names a group without a name by its members", async () => {
			installLocalStorage({ allowHttp: true });
			const env = await createSyncEnv([TARGET]);
			const configId = env.configIds[0];
			await env.chat.repo.setSourceState({ configId, selfPartnerId: 3 });
			await env.chat.repo.applyDelta(configId, {
				channels: [{ channelId: 5, channelType: "group", name: "", isMember: true }],
				deletedChannelIds: [],
				members: [{ memberId: 1, channelId: 5, partnerId: 3 }, { memberId: 2, channelId: 5, partnerId: 7 }],
				deletedMemberIds: [],
				messages: [],
				partners: [{ partnerId: 3, name: "Ann" }, { partnerId: 7, name: "Bob" }] as any,
				inboxCounter: null,
				selfPartnerId: null,
			} as any);
			expect(await chatTitle(env, configId, 5)).toBe("Ann and Bob");
			await env.chat.repo.patchChannel(configId, 5, { name: "Team" });
			expect(await chatTitle(env, configId, 5)).toBe("Team");
			await expect(chatTitle(env, configId, 6)).rejects.toThrow();
		});

		it("nodeTransport is a BusTransport with inert default handlers", () => {
			const t = nodeTransport();
			for (const m of ["open", "send", "close", "onOpen", "onMessage", "onClose"] as const) {
				expect(typeof t[m]).toBe("function");
			}
			expect(() => t.send("x")).not.toThrow();
		});
	});
});
