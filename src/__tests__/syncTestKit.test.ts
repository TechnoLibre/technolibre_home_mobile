import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { __setNetworkStatus, Network } from "@capacitor/network";
import {
	HARNESS_API, createSyncEnv, nodeTransport, installLocalStorage, memoryAttachmentIO, resetMocks,
	restartSyncEnv, setOnline, setNetwork, chatTitle, memoryChatFiles, nodeChatHttp, stageChatFile, stageChatVoice,
	composeBody, bodyText, emojiConversions, isEmptyMessage, EMPTY_MENTIONS,
	foldText, htmlTerm, mailboxKindOf, noteForRecord,
	parseNtfyLink, decryptWebPush, pollNtfy, pushNodeNative,
} from "../testing/syncTestKit";
import { syncSessionKey } from "../services/syncService";
import { isHttpAllowed } from "../services/odoo/httpPolicy";
import { deviceAttachmentIO } from "../services/attachmentService";
import { RequestNotSentError } from "../services/odoo/odooRpcClient";
import { ChatTransferCancelledError, UPLOAD_SLACK_BYTES } from "../services/chat/chatTransfer";

const TARGET = { url: "http://odoo.test:8069", username: "admin", password: "admin", database: "db1" };

describe("syncTestKit", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		resetMocks();
	});

	it("is at API 6", () => {
		expect(HARNESS_API).toBe(6);
	});

	it("gives the chat's finding rules: folded text, the server's body term, inbox kinds, the note of a record", () => {
		expect(foldText("Café CRÈME")).toBe("cafe creme");
		expect(htmlTerm("l'eau & co 100%")).toBe("l'eau%&amp;%co%100\\%");
		const item = {
			configId: "c", messageId: 1, threadModel: "project.task", threadId: 5, recordName: "Tâche démo",
			authorPartnerId: null, body: "", date: null, messageType: "comment", needaction: true, starred: false, history: false,
		};
		expect(mailboxKindOf(item)).toBe("record");
		expect(mailboxKindOf({ ...item, messageType: "user_notification" })).toBe("assignment");
		expect(mailboxKindOf({ ...item, threadModel: "discuss.channel" })).toBe("mention");
		const link = { noteId: "n1", configId: "c", kind: "create", model: "project.task", resId: 5, remoteState: "ok" } as any;
		expect(noteForRecord([link], "c", "project.task", 5)?.noteId).toBe("n1");
		expect(noteForRecord([link], "c", "project.task", 6)).toBeNull();
	});

	it("gives the chat's body rules: a composed body reads back as its text, an emptied one is hidden", async () => {
		const mentions = { partners: [{ id: 7, name: "Alice Martin" }], channels: [] };
		const composed = composeBody("@Alice Martin :) voir\nwww.example.org", mentions, await emojiConversions());
		expect(composed.partnerIds).toEqual([7]);
		expect(composed.body).toContain('data-oe-id="7"');
		expect(bodyText(composed.body)).toBe("@Alice Martin 😊 voir\nwww.example.org");
		expect(composeBody("texte", EMPTY_MENTIONS, []).partnerIds).toEqual([]);
		expect(isEmptyMessage('<span class="o-mail-Message-edited"></span>', 0)).toBe(true);
		expect(isEmptyMessage("", 1)).toBe(false);
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

	it("gives binary files as they are", async () => {
		const bytes = new Uint8Array([0, 0xff, 0xd8, 10, 0]);
		const io = memoryAttachmentIO({ files: { "a.jpg": bytes, "b.bin": Buffer.from([1, 2]) } });
		expect(await io.size("a.jpg")).toBe(5);
		expect([...Buffer.from(await io.read("a.jpg"), "base64")]).toEqual([...bytes]);
		expect(await io.size("b.bin")).toBe(2);
	});

	it("setNetwork tells a mobile network from Wi-Fi", async () => {
		setNetwork({ connected: true, wifi: false });
		expect(await Network.getStatus()).toEqual({ connected: true, connectionType: "cellular" });
		expect(await deviceAttachmentIO.onWifi()).toBe(false);
		setNetwork({ connected: true, wifi: true });
		expect(await deviceAttachmentIO.onWifi()).toBe(true);
		setNetwork({ connected: false, wifi: false });
		expect(await Network.getStatus()).toEqual({ connected: false, connectionType: "none" });
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
			await (env.chat as any).repo.setSourceState({ configId, moduleState: "installed", moduleLevel: "1.2" });
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
			await env.chat.repo.setSourceState({ configId, moduleState: "installed", moduleLevel: "1.2", isSystem: true });
			expect(await env.chat.features(configId)).toEqual({ canRemoveMembers: false, idempotentCreate: false, idempotentUpload: false, guardedEdit: false, serverSearch: false, idempotentStar: false, idempotentRecordPost: false });
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

		it("createSyncEnv gives the chat memory files, which restartSyncEnv keeps", async () => {
			installLocalStorage({ allowHttp: true });
			const files = memoryChatFiles();
			const env = await createSyncEnv([TARGET], { chatFiles: files });
			expect(env.chatFiles).toBe(files);
			expect(env.chat.queue.files).toBe(files);
			expect((await createSyncEnv([TARGET])).chatFiles).not.toBe(files);
			const after = await restartSyncEnv(env);
			expect(after.chatFiles).toBe(files);
			expect(after.chat.queue.files).toBe(files);
		});

		it("stageChatFile stages under out/ and refuses a file over the session limit, writing nothing", async () => {
			installLocalStorage({ allowHttp: true });
			const env = await createSyncEnv([TARGET]);
			const configId = env.configIds[0];
			const src = { configId, creds: env.creds[0], label: "x", app: {} } as any;
			const limit = vi.spyOn(env.chat, "uploadLimit").mockResolvedValue(UPLOAD_SLACK_BYTES + 4);
			const staged: any = await stageChatFile(env, src, { name: "a.jpg", bytes: new Uint8Array([1, 2, 3, 4]) });
			expect(staged).toMatchObject({ name: "a.jpg", mimetype: "image/jpeg", size: 4, voice: false });
			expect(staged.path).toBe(`chat/${await env.chat.fileDirOf(configId)}/out/${staged.localUuid}/a.jpg`);
			expect([...env.chatFiles.bytes(staged.path)!]).toEqual([1, 2, 3, 4]);
			expect(await stageChatFile(env, src, { name: "b.pdf", bytes: new Uint8Array(5) }))
				.toEqual({ refused: "too_big", limit: UPLOAD_SLACK_BYTES + 4 });
			expect(await env.chatFiles.list(`chat/${await env.chat.fileDirOf(configId)}/out`)).toEqual([staged.localUuid]);
			limit.mockRestore();
		});

		it("stageChatVoice stages an MP3 under the recorder's name", async () => {
			installLocalStorage({ allowHttp: true });
			const env = await createSyncEnv([TARGET]);
			const voice = await stageChatVoice(env, env.configIds[0], 0.5);
			expect(voice).toMatchObject({ mimetype: "audio/mpeg", voice: true });
			expect(voice.name).toMatch(/^Voice-\d{4}-\d{2}-\d{2}-\d+\.mp3$/);
			const mp3 = env.chatFiles.bytes(voice.path)!;
			expect(mp3.length).toBe(voice.size);
			expect([mp3[0], mp3[1] & 0xfe]).toEqual([0xff, 0xfa]);
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
				attachments: [],
				deletedAttachmentIds: [],
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

	describe("nodeChatHttp", () => {
		let server: http.Server;
		let base: string;
		const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }[] = [];

		beforeAll(async () => {
			server = http.createServer(async (req, res) => {
				const chunks: Buffer[] = [];
				for await (const c of req) chunks.push(c as Buffer);
				seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
				if (req.url === "/moved") {
					res.writeHead(303, { location: "/web/login?redirect=x" });
					res.end();
				} else if (req.url === "/cut") {
					req.socket.destroy();
				} else if (req.url === "/slow") {
					setTimeout(() => res.end("late"), 2000);
				} else if (req.url === "/file") {
					res.writeHead(200, { "content-type": "image/png; charset=binary" });
					res.end(Buffer.from([0x89, 0x50, 0, 0xff]));
				} else if (req.url === "/gone") {
					res.writeHead(404, { "content-type": "text/html" });
					res.end("nope");
				} else {
					res.writeHead(200, { "content-type": "application/json", "set-cookie": ["a=1", "b=2"] });
					res.end('{"ok":true}');
				}
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		});
		afterAll(async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});

		it("getText follows no redirect and gives lowercase headers", async () => {
			const httpc = nodeChatHttp(memoryChatFiles());
			const moved = await httpc.getText(`${base}/moved`, { Cookie: "session_id=s1" });
			expect(moved).toMatchObject({ status: 303, headers: { location: "/web/login?redirect=x" } });
			expect(seen.at(-1)!.headers.cookie).toBe("session_id=s1");
			const ok = await httpc.getText(`${base}/json`, {});
			expect(ok).toMatchObject({ status: 200, data: '{"ok":true}', headers: { "content-type": "application/json", "set-cookie": "a=1" } });
		});

		it("upload posts the fields in order then ufile read from the files, and reports the bytes", async () => {
			const files = memoryChatFiles();
			files.put("chat/d/out/u/a b.jpg", new Uint8Array([0, 1, 0xff]));
			const httpc = nodeChatHttp(files);
			const events: any[] = [];
			httpc.onProgress((p) => events.push(p));
			const answer = await httpc.upload({
				id: "up1", url: `${base}/upload`, headers: { Cookie: "session_id=s1" },
				fields: { thread_id: "7", csrf_token: "tok" },
				file: { uri: await files.uri("chat/d/out/u/a b.jpg"), name: "a b.jpg", mimetype: "image/jpeg" },
			});
			expect(answer.status).toBe(200);
			const { headers, body } = seen.at(-1)!;
			const text = body.toString("latin1");
			expect(headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
			expect(text.indexOf('name="thread_id"')).toBeLessThan(text.indexOf('name="csrf_token"'));
			expect(text.indexOf('name="csrf_token"')).toBeLessThan(text.indexOf('name="ufile"; filename="a b.jpg"'));
			expect(text).toContain("Content-Type: image/jpeg\r\n\r\n\u0000\u0001\u00ff\r\n");
			expect(events).toEqual([{ id: "up1", done: 3, total: 3 }]);
		});

		it("download writes the bytes with their SHA-1 and type; another status writes nothing", async () => {
			const files = memoryChatFiles();
			const httpc = nodeChatHttp(files);
			const uri = await files.uri("chat/d/files/9/x.png");
			const answer = await httpc.download({ id: "d1", url: `${base}/file`, headers: {}, uri });
			const bytes = Buffer.from([0x89, 0x50, 0, 0xff]);
			expect(answer).toEqual({ status: 200, size: 4, sha1: createHash("sha1").update(bytes).digest("hex"), mimetype: "image/png" });
			expect([...files.bytes("chat/d/files/9/x.png")!]).toEqual([...bytes]);
			// The memory files read a path and its file: URI alike
			expect(await files.size("chat/d/files/9/x.png")).toBe(4);
			expect(await files.size(uri)).toBe(4);
			const gone = await httpc.download({ id: "d2", url: `${base}/gone`, headers: {}, uri: await files.uri("chat/d/thumbs/9") });
			expect(gone).toEqual({ status: 404, size: 0, sha1: null, mimetype: null });
			expect(files.bytes("chat/d/thumbs/9")).toBeUndefined();
		});

		it("tells a request never sent from one cut after it went, and from a cancel", async () => {
			const httpc = nodeChatHttp(memoryChatFiles());
			// A port just freed: nothing listens there
			const closed = http.createServer();
			await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
			const { port } = closed.address() as AddressInfo;
			await new Promise<void>((resolve) => closed.close(() => resolve()));
			await expect(httpc.getText(`http://127.0.0.1:${port}/x`, {})).rejects.toBeInstanceOf(RequestNotSentError);
			const cut = await httpc.getText(`${base}/cut`, {}).catch((e) => e);
			expect(cut).toBeInstanceOf(Error);
			expect(cut).not.toBeInstanceOf(RequestNotSentError);
			const slow = httpc.download({ id: "d3", url: `${base}/slow`, headers: {}, uri: "file:///memory/files/x" });
			await vi.waitFor(() => expect(seen.at(-1)!.url).toBe("/slow"));
			await httpc.cancel("d3");
			await expect(slow).rejects.toBeInstanceOf(ChatTransferCancelledError);
		});

		it("upload of a missing file is never sent", async () => {
			const httpc = nodeChatHttp(memoryChatFiles());
			const before = seen.length;
			await expect(httpc.upload({
				id: "up2", url: `${base}/upload`, headers: {}, fields: {},
				file: { uri: "file:///memory/files/none", name: "none", mimetype: "text/plain" },
			})).rejects.toBeInstanceOf(RequestNotSentError);
			expect(seen.length).toBe(before);
		});
	});
	describe("chat push", () => {
		let server: http.Server;
		let base: string;
		/** Topics the fake ntfy lets the token read, and the events it answers per topic. */
		const readable = new Set<string>();
		const events = new Map<string, string[]>();
		const seen: { url: string; auth: string | undefined }[] = [];
		const TOKEN = "tk_exempleexempleexempleexemple";

		beforeAll(async () => {
			server = http.createServer((req, res) => {
				seen.push({ url: req.url!, auth: req.headers.authorization });
				const url = new URL(req.url!, "http://x");
				const topics = url.pathname.split("/")[1].split(",");
				if (req.headers.authorization !== `Bearer ${TOKEN}`) {
					res.writeHead(401).end('{"code":40101}');
				} else if (!topics.every((t) => readable.has(t))) {
					res.writeHead(403).end('{"code":40301}');
				} else {
					res.writeHead(200, { "content-type": "application/x-ndjson" });
					res.end(topics.flatMap((t) => events.get(t) ?? []).map((e) => e + "\n").join(""));
				}
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		});
		afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

		it("parses the setup link the operator's tool prints", () => {
			const link = parseNtfyLink(
				"erplibre-ntfy:setup?v=1&url=http%3A%2F%2Fntfy.exemple.test%3A8080&token=tk_exempleexempleexempleexemple"
					+ "&prefix=upab12cd34&cache=43200&odoo=http%3A%2F%2Fodoo-ntfy.exemple.test%3A8080",
			);
			expect(link).toEqual({
				url: "http://ntfy.exemple.test:8080", token: TOKEN, prefix: "upab12cd34", cacheSeconds: 43200,
				odooUrl: "http://odoo-ntfy.exemple.test:8080",
			});
		});

		it("pushNodeNative stores an ntfy only once its token reads <prefix>check", async () => {
			const native = pushNodeNative();
			await native.publishSettings({ level: 3, allowHttp: true, strings: {}, accounts: [] });
			expect(await native.setNtfy({ url: base, token: TOKEN, prefix: "upab12cd34", cacheSeconds: 43200 }))
				.toEqual({ ok: false, reason: "forbidden" });
			expect(await native.setNtfy({ url: base, token: "tk_autre", prefix: "upab12cd34", cacheSeconds: 43200 }))
				.toEqual({ ok: false, reason: "unauthorized" });
			await expect(native.subscribe({ configId: "c", ntfyUrl: base, renew: false })).rejects.toThrow(/ChatPushPlugin.subscribe/);
			readable.add("upab12cd34check");
			expect(await native.setNtfy({ url: base, token: TOKEN, prefix: "upab12cd34", cacheSeconds: 43200 }))
				.toEqual({ ok: true, reason: null });
			expect(seen.at(-1)).toEqual({ url: "/upab12cd34check/json?poll=1&since=all", auth: `Bearer ${TOKEN}` });
			const closed = await native.setNtfy({ url: "http://127.0.0.1:1", token: TOKEN, prefix: "upab12cd34", cacheSeconds: 60 });
			expect(closed).toEqual({ ok: false, reason: "unreachable" });
		});

		it("pushNodeNative subscribes with an R4 topic and a P-256 key pair, kept until renewed", async () => {
			readable.add("upab12cd34check");
			const native = pushNodeNative();
			await native.publishSettings({ level: 3, allowHttp: true, strings: {}, accounts: [] });
			await native.setNtfy({ url: base, token: TOKEN, prefix: "upab12cd34", cacheSeconds: 43200 });
			const sub = await native.subscribe({ configId: "c", ntfyUrl: base, renew: false });
			expect(sub.topic).toMatch(/^upab12cd34[a-z0-9]{22}$/);
			const keys = native.keysOf("c");
			expect(keys.topic).toBe(sub.topic);
			expect(Buffer.from(sub.p256dh, "base64url")).toEqual(Buffer.from(keys.publicKey));
			expect(keys.publicKey.length).toBe(65);
			expect(keys.publicKey[0]).toBe(4);
			expect(Buffer.from(sub.auth, "base64url")).toEqual(Buffer.from(keys.auth));
			expect(keys.auth.length).toBe(16);
			expect(keys.privateKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
			expect(await native.subscribe({ configId: "c", ntfyUrl: base, renew: false })).toEqual(sub);
			const renewed = await native.subscribe({ configId: "c", ntfyUrl: base, renew: true });
			expect(renewed.topic).not.toBe(sub.topic);
			expect(renewed.p256dh).not.toBe(sub.p256dh);
			await native.unsubscribe({ configId: "c", pendingEndpoint: null });
			expect(() => native.keysOf("c")).toThrow();
			expect(native.calls.map((c) => c.method)).toEqual(["publishSettings", "setNtfy", "subscribe", "subscribe", "subscribe", "unsubscribe"]);
		});

		it("pushNodeNative refuses an http ntfy until the mirror allows http", async () => {
			readable.add("upab12cd34check");
			const native = pushNodeNative();
			await native.publishSettings({ level: 3, allowHttp: false, strings: {}, accounts: [] });
			expect(await native.setNtfy({ url: base, token: TOKEN, prefix: "upab12cd34", cacheSeconds: 60 }))
				.toEqual({ ok: false, reason: "http_refused" });
			await native.publishSettings({ level: 3, allowHttp: true, strings: {}, accounts: [] });
			expect((await native.setNtfy({ url: base, token: TOKEN, prefix: "upab12cd34", cacheSeconds: 60 })).ok).toBe(true);
		});

		it("pollNtfy reads the messages of several topics, base64 bodies as bytes", async () => {
			readable.add("upab12cd34aaa").add("upab12cd34bbb");
			events.set("upab12cd34aaa", [
				JSON.stringify({ id: "m1", event: "open", topic: "upab12cd34aaa" }),
				JSON.stringify({ id: "m2", event: "message", topic: "upab12cd34aaa", message: "AQID", encoding: "base64" }),
			]);
			events.set("upab12cd34bbb", [JSON.stringify({ id: "m3", event: "message", topic: "upab12cd34bbb", message: "texte" })]);
			const got = await pollNtfy({ url: base, token: TOKEN }, ["upab12cd34aaa", "upab12cd34bbb"], "m0");
			expect(seen.at(-1)!.url).toBe("/upab12cd34aaa,upab12cd34bbb/json?poll=1&since=m0");
			expect(got.map((m) => [m.id, m.topic, [...m.body]])).toEqual([
				["m2", "upab12cd34aaa", [1, 2, 3]],
				["m3", "upab12cd34bbb", [...Buffer.from("texte")]],
			]);
			const refused = await pollNtfy({ url: base, token: TOKEN }, ["upzz99yy88"], "all").catch((e) => e);
			expect(refused).toMatchObject({ status: 403 });
		});

		it("createSyncEnv gives the chat a ChatPush over the node native, which restartSyncEnv keeps", async () => {
			installLocalStorage({ allowHttp: true });
			const env = await createSyncEnv([TARGET]);
			expect(env.push).toBe(env.chat.push);
			expect(env.push.native).toBe(env.pushNative);
			const after = await restartSyncEnv(env);
			expect(after.push).toBe(after.chat.push);
			expect(after.push).not.toBe(env.push);
			expect(after.pushNative).toBe(env.pushNative);
			expect(typeof decryptWebPush).toBe("function");
		});
	});
});
