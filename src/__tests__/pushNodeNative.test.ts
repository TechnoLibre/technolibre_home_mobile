import { describe, it, expect } from "vitest";
import { pushNodeNative } from "../testing/pushNodeNative";
import type { PushSettingsMirror } from "../plugins/chatPushPlugin";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("pushNodeNative action store", () => {
	it("lists the done and handoff records oldest first, each filled from its partial", async () => {
		const native = pushNodeNative();
		const handoff = native.addAction({
			configId: "c1", kind: "reply", state: "handoff", reason: "session_expired", channelId: 4, text: "Bonjour", createdAt: 2000,
		});
		const done = native.addAction({ configId: "c1", kind: "read", channelId: 4, messageId: 17, createdAt: 1000 });
		expect(await native.actions()).toEqual([done, handoff]);
		expect(done).toEqual({
			id: expect.any(String),
			configId: "c1",
			kind: "read",
			state: "done",
			reason: null,
			channelId: 4,
			messageId: 17,
			clientUuid: expect.stringMatching(UUID_V4),
			text: "",
			content: "",
			createdAt: 1000,
			sentAt: null,
			plainSent: false,
			answer: null,
		});
		expect(handoff).toMatchObject({ state: "handoff", reason: "session_expired", text: "Bonjour", messageId: null });
		expect(handoff.id).not.toBe(done.id);
		expect(handoff.clientUuid).not.toBe(done.clientUuid);
		expect(native.calls.map((c) => c.method)).toEqual(["actions"]);
	});

	it("serves copies: a drain changing a record changes nothing stored", async () => {
		const native = pushNodeNative();
		const added = native.addAction({ configId: "c1", kind: "react", content: "👍", messageId: 9 });
		const [served] = await native.actions();
		served.content = "❤️";
		added.messageId = 1;
		expect((await native.actions())[0]).toMatchObject({ content: "👍", messageId: 9 });
	});

	it("ack forgets the acked records and keeps the others", async () => {
		const native = pushNodeNative();
		const a = native.addAction({ configId: "c1", kind: "read", createdAt: 1 });
		const b = native.addAction({ configId: "c1", kind: "mute", createdAt: 2 });
		const c = native.addAction({ configId: "c2", kind: "reply", state: "handoff", reason: "refused", createdAt: 3 });
		await native.ackActions({ ids: [a.id, c.id, "inconnu"] });
		expect((await native.actions()).map((r) => r.id)).toEqual([b.id]);
		expect(native.calls.find((x) => x.method === "ackActions")?.args).toEqual({ ids: [a.id, c.id, "inconnu"] });
	});
});

describe("pushNodeNative mirror and status", () => {
	const mirror: PushSettingsMirror = {
		level: 1,
		allowHttp: true,
		strings: {},
		accounts: [{
			configId: "c1",
			label: "Exemple",
			lockScreen: "hidden_locked",
			module: "1.6",
			channels: [{ id: 4, name: "canal", type: "channel" }],
			filter: "mentions_dm",
			inbox: false,
			inboxMentions: true,
			quiet: { on: true, from: 1320, to: 420 },
			channelNotifications: "no_notif",
		}],
		climb: { auto: true, oneBelow: 30, twoBelow: 15 },
		browserMode: "quiet",
	};

	it("keeps the published mirror, the phone and account preferences included", async () => {
		const native = pushNodeNative();
		await native.publishSettings(mirror);
		expect(native.settings).toEqual(mirror);
		expect(native.calls).toEqual([{ method: "publishSettings", args: mirror }]);
	});

	it("reports the chosen level as effective until a test sets the climbed one and its reason", async () => {
		const native = pushNodeNative();
		await native.publishSettings(mirror);
		expect(await native.status()).toMatchObject({ level: 1, effectiveLevel: 1, climbReason: null, mode: "realtime" });
		native.effectiveLevel = 3;
		native.climbReason = "below_two";
		expect(await native.status()).toMatchObject({ level: 1, effectiveLevel: 3, climbReason: "below_two", mode: "poll_15" });
		native.effectiveLevel = 4;
		native.climbReason = "saver";
		expect(await native.status()).toMatchObject({ effectiveLevel: 4, climbReason: "saver", mode: "poll_60" });
		native.effectiveLevel = null;
		native.climbReason = null;
		expect(await native.status()).toMatchObject({ level: 1, effectiveLevel: 1, climbReason: null, mode: "realtime" });
	});
});
