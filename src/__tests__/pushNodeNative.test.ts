import { describe, it, expect } from "vitest";
import { pushNodeNative } from "../testing/pushNodeNative";

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
