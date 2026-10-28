/**
 * Web Push message decryption in Node, for the tests only: RFC 8291 key
 * derivation over the RFC 8188 aes128gcm content coding, the same steps as
 * the app's native WebPushDecrypt. The header is salt(16) || rs(4, big
 * endian) || idlen(1) || keyid, keyid being the sender's 65-byte public key.
 */
import { createDecipheriv, createPublicKey, diffieHellman, hkdfSync, type KeyObject } from "node:crypto";

const HEADER_FIXED = 21;
const PUBLIC_LEN = 65;
const TAG_LEN = 16;
const KEY_INFO = Buffer.from("WebPush: info\0", "ascii");
const CEK_INFO = Buffer.from("Content-Encoding: aes128gcm\0", "ascii");
const NONCE_INFO = Buffer.from("Content-Encoding: nonce\0", "ascii");

/** A P-256 public key from its uncompressed point (0x04 || x || y). */
export function publicKeyOf(point: Uint8Array): KeyObject {
	if (point.length !== PUBLIC_LEN || point[0] !== 4) throw new Error("bad header: not an uncompressed P-256 point");
	return createPublicKey({
		key: {
			kty: "EC",
			crv: "P-256",
			x: Buffer.from(point.subarray(1, 33)).toString("base64url"),
			y: Buffer.from(point.subarray(33, 65)).toString("base64url"),
		},
		format: "jwk",
	});
}

const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number) =>
	Buffer.from(hkdfSync("sha256", ikm, salt, info, length));

/**
 * The plaintext of an aes128gcm body for the subscription whose key pair
 * is (privateKey, uaPublic) and whose auth secret is auth. Every record is
 * authenticated and its padding delimiter checked: 0x01 on all but the
 * last record, 0x02 on the last one, so a body cut at a record boundary
 * is refused. A failure throws an Error whose message starts with its
 * kind: truncated, bad header, auth failed, bad padding.
 */
export function decryptWebPush(body: Uint8Array, privateKey: KeyObject, uaPublic: Uint8Array, auth: Uint8Array): Uint8Array {
	if (body.length < HEADER_FIXED) throw new Error("truncated: no header");
	const view = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	const rs = view.readUInt32BE(16);
	const idlen = view[20];
	if (idlen !== PUBLIC_LEN || rs < TAG_LEN + 2) throw new Error("bad header: record size or key id");
	const dataStart = HEADER_FIXED + idlen;
	if (view.length <= dataStart) throw new Error("truncated: no record");
	const salt = view.subarray(0, 16);
	const keyid = view.subarray(HEADER_FIXED, dataStart);

	const ecdh = diffieHellman({ privateKey, publicKey: publicKeyOf(keyid) });
	const ikm = hkdf(ecdh, auth, Buffer.concat([KEY_INFO, uaPublic, keyid]), 32);
	const cek = hkdf(ikm, salt, CEK_INFO, 16);
	const baseNonce = hkdf(ikm, salt, NONCE_INFO, 12);

	const out: Buffer[] = [];
	let pos = dataStart;
	let seq = 0n;
	while (pos < view.length) {
		const len = Math.min(rs, view.length - pos);
		const last = pos + len >= view.length;
		if (len < TAG_LEN + 1) throw new Error("truncated: record shorter than its tag");
		const nonce = Buffer.from(baseNonce);
		nonce.writeBigUInt64BE(nonce.readBigUInt64BE(4) ^ seq, 4);
		const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
		decipher.setAuthTag(view.subarray(pos + len - TAG_LEN, pos + len));
		let plain: Buffer;
		try {
			plain = Buffer.concat([decipher.update(view.subarray(pos, pos + len - TAG_LEN)), decipher.final()]);
		} catch {
			throw new Error("auth failed: the record does not authenticate");
		}
		let end = plain.length;
		while (end > 0 && plain[end - 1] === 0) end--;
		if (end === 0 || plain[end - 1] !== (last ? 2 : 1)) throw new Error("bad padding: wrong delimiter");
		out.push(plain.subarray(0, end - 1));
		pos += len;
		seq += 1n;
	}
	return new Uint8Array(Buffer.concat(out));
}
