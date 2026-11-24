import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPrivateKey, type KeyObject } from "node:crypto";
import { decryptWebPush } from "../testing/webPushNode";

/** The Android test vectors (WebPushDecryptTest): the same values on both sides. */
const VECTOR = resolve(__dirname, "../../android/app/src/test/resources/chatpush/odoo18_push.json");

const b64url = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));

/** A P-256 private key from its raw scalar and its uncompressed public point. */
function scalarKey(d: Uint8Array, publicPoint: Uint8Array): KeyObject {
	const jwk = {
		kty: "EC",
		crv: "P-256",
		d: Buffer.from(d).toString("base64url"),
		x: Buffer.from(publicPoint.subarray(1, 33)).toString("base64url"),
		y: Buffer.from(publicPoint.subarray(33, 65)).toString("base64url"),
	};
	return createPrivateKey({ key: jwk, format: "jwk" });
}

/** RFC 8291 section 5 and appendix A, values verbatim. */
const RFC = {
	body: b64url(
		"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml"
			+ "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT"
			+ "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
	),
	auth: b64url("BTBZMqHH6r4Tts7J_aSIgg"),
	uaPublic: b64url("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
	uaPrivate: b64url("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"),
};

describe("decryptWebPush", () => {
	it("decrypts the RFC 8291 appendix A message", () => {
		const plain = decryptWebPush(RFC.body, scalarKey(RFC.uaPrivate, RFC.uaPublic), RFC.uaPublic, RFC.auth);
		expect(Buffer.from(plain).toString("utf8")).toBe("When I grow up, I want to be a watermelon");
	});

	it("decrypts the Odoo 18 push to its JSON", () => {
		const vector = JSON.parse(readFileSync(VECTOR, "utf8"));
		const privateKey = createPrivateKey({ key: Buffer.from(vector.ua_private_pkcs8, "base64"), format: "der", type: "pkcs8" });
		const plain = decryptWebPush(
			new Uint8Array(Buffer.from(vector.body, "base64")),
			privateKey,
			b64url(vector.ua_public),
			b64url(vector.auth),
		);
		expect(Buffer.from(plain).toString("utf8")).toBe(vector.plaintext);
		expect(JSON.parse(vector.plaintext).options.data).toEqual({ model: "discuss.channel", res_id: 4, action: "mail.action_discuss" });
	});

	it("refuses another auth secret", () => {
		const auth = RFC.auth.slice();
		auth[0] ^= 1;
		expect(() => decryptWebPush(RFC.body, scalarKey(RFC.uaPrivate, RFC.uaPublic), RFC.uaPublic, auth)).toThrow(/auth/);
	});

	it("refuses a body cut inside its record", () => {
		const cut = RFC.body.subarray(0, RFC.body.length - 1);
		expect(() => decryptWebPush(cut, scalarKey(RFC.uaPrivate, RFC.uaPublic), RFC.uaPublic, RFC.auth)).toThrow(/auth/);
	});

	it("refuses a header shorter than its fixed part", () => {
		expect(() => decryptWebPush(RFC.body.subarray(0, 20), scalarKey(RFC.uaPrivate, RFC.uaPublic), RFC.uaPublic, RFC.auth))
			.toThrow(/truncated/);
	});
});
