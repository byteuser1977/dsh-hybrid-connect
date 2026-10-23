// tests/credentials.test.js — unit tests for dsh-hybrid-connect credentials.js
// Covers decryptStorageValue (tc envelope), classifyEdition (fallback heuristic)
// and the TraeCredentialStore sync-discover contract.
// Run: node --test

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptStorageValue, classifyEdition, TraeCredentialStore } from "../credentials.js";

// --- helpers ---------------------------------------------------------------

// Re-implement the ENCODE direction of the tc envelope (inverse of
// decryptStorageValue) so we can round-trip a synthetic credential.
const SALT_A = Buffer.from([
	82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251,
	124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203,
	84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78,
	8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
]);
const SALT_B = Buffer.from([
	31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95,
	96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239,
	160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97,
	23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
]);
const SALT = Buffer.alloc(SALT_A.length);
for (let i = 0; i < SALT_A.length; i++) SALT[i] = SALT_A[i] ^ SALT_B[i];

function xorInto(a, b) {
	const out = Buffer.alloc(a.length);
	for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
	return out;
}

/** Encrypt one plaintext JSON string into a tc envelope (base64). */
function encryptStorageValue(plainJson) {
	const random = randomBytes(32);
	const hashOfRandom = createHash("sha512").update(random).digest();
	const finalHash = createHash("sha512").update(Buffer.concat([hashOfRandom, SALT])).digest();
	const key = finalHash.subarray(0, 16);
	const iv = finalHash.subarray(16, 32);

	const body = Buffer.from(plainJson, "utf8");
	const hash = createHash("sha512").update(body).digest(); // 64 bytes
	const padLen = 16 - ((64 + body.length) % 16 || 16);    // PKCS7 to 16-byte block
	const paddedBody = Buffer.concat([body, Buffer.alloc(padLen, padLen)]);

	const cipher = createCipheriv("aes-128-cbc", key, iv);
	cipher.setAutoPadding(false);
	const ciphertext = Buffer.concat([cipher.update(Buffer.concat([hash, paddedBody])), cipher.final()]);

	const header = Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]); // "tc\x05\x10\x00\x00"
	return Buffer.concat([header, random, ciphertext]).toString("base64");
}

// --- decryptStorageValue ---------------------------------------------------

describe("credentials.decryptStorageValue", () => {
	test("round-trips a synthetic tc envelope", () => {
		const plain = JSON.stringify({ token: "jwt-abc", refreshToken: "r", userId: "u1" });
		const envelope = encryptStorageValue(plain);
		assert.equal(decryptStorageValue(envelope), plain);
	});

	test("throws on too-short buffer", () => {
		assert.throws(() => decryptStorageValue(Buffer.alloc(10).toString("base64")), /too short/);
	});

	test("throws on unknown encryption header", () => {
		const buf = Buffer.concat([Buffer.from([1, 2, 3, 4, 5, 6]), Buffer.alloc(100)]);
		assert.throws(() => decryptStorageValue(buf.toString("base64")), /unknown Trae encryption header/);
	});

	test("throws when SHA-512 integrity check fails (wrong key)", () => {
		// Valid envelope, then flip one ciphertext byte → hash mismatch
		const envelope = encryptStorageValue(JSON.stringify({ token: "t" }));
		const buf = Buffer.from(envelope, "base64");
		buf[buf.length - 1] ^= 0xff;
		assert.throws(() => decryptStorageValue(buf.toString("base64")), /hash verification failed/);
	});
});

// --- classifyEdition (fallback heuristic) ----------------------------------

describe("credentials.classifyEdition (fallback heuristic)", () => {
	test("intl host → intl", () => {
		assert.equal(classifyEdition("Trae", { host: "https://growsg-normal.trae.ai" }), "intl");
		assert.equal(classifyEdition("Trae", { host: "https://core-normal.trae.ai" }), "intl");
	});
	test("cn host → cn", () => {
		assert.equal(classifyEdition("Trae CN", { host: "https://api.trae.cn" }), "cn");
		assert.equal(classifyEdition("Trae CN", { host: "https://trae-api-cn.mchost.guru" }), "cn");
	});
	test("region wins when host uninformative", () => {
		assert.equal(classifyEdition("Trae", { host: "", userRegion: { region: "SG" } }), "intl");
		assert.equal(classifyEdition("Trae", { host: "", userRegion: { region: "CN" } }), "cn");
	});
	test("dir name as last resort", () => {
		assert.equal(classifyEdition("Trae CN", { host: "", userRegion: {} }), "cn");
		assert.equal(classifyEdition("Trae", { host: "", userRegion: {} }), "intl");
	});
});

// --- TraeCredentialStore ---------------------------------------------------

describe("credentials.TraeCredentialStore", () => {
	test("without an injected discover callback: no credential, nothing persisted", () => {
		// The desktop discovery callback is SYNCHRONOUS by contract. Its async
		// default used to hand load() a Promise, which destructured into {} and
		// persisted an empty credential — this guards against that regression.
		const dir = mkdtempSync(join(tmpdir(), "dsh-hybrid-"));
		const path = join(dir, "credentials.json");
		try {
			const store = new TraeCredentialStore({ edition: "cn", path });
			assert.equal(store.load(), undefined);
			assert.equal(store.current, undefined);
			assert.equal(existsSync(path), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("injected synchronous discover is adopted and persisted", () => {
		const dir = mkdtempSync(join(tmpdir(), "dsh-hybrid-"));
		const path = join(dir, "credentials.json");
		try {
			const auth = { token: "jwt-abc", userId: "u1", host: "https://api.trae.cn" };
			const store = new TraeCredentialStore({ edition: "cn", path, discover: () => auth });
			const loaded = store.load();
			assert.equal(loaded.auth.token, "jwt-abc");
			assert.equal(loaded.source, "desktop");
			assert.equal(existsSync(path), true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
