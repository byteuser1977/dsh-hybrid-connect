// tests/router.test.js — unit tests for dsh-hybrid-connect router.js
// Run: node --test tests/

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createRouteDecider } from "../router.js";

function makeDecider(overrides = {}) {
	return createRouteDecider({
		localBase: overrides.localBase ?? (() => ""),
		localKey: overrides.localKey ?? (() => ""),
		hybridPolicy: overrides.hybridPolicy ?? (() => "by-prefix"),
		logger: overrides.logger ?? undefined,
	});
}

describe("router — by-prefix policy (default)", () => {
	test("localBase empty → everything routes to Trae, no local I/O", async () => {
		const decider = makeDecider({ localBase: () => "" });
		assert.deepEqual(await decider("any-model", "cn"), { kind: "trae", model: "any-model" });
		assert.deepEqual(await decider("local@qwen2.5:14b", "cn"), { kind: "trae", model: "local@qwen2.5:14b" });
	});

	test("local@ prefix routes local, strips prefix from wire model", async () => {
		const decider = makeDecider({
			localBase: () => "http://127.0.0.1:11434/v1",
			localKey: () => "sk-test",
		});
		assert.deepEqual(await decider("local@qwen2.5:14b", "cn"), {
			kind: "local",
			baseUrl: "http://127.0.0.1:11434/v1",
			key: "sk-test",
			model: "qwen2.5:14b",
		});
	});

	test("non-local@ model routes to Trae even when local is configured", async () => {
		const decider = makeDecider({
			localBase: () => "http://127.0.0.1:11434/v1",
		});
		assert.deepEqual(await decider("deepseek-v4.1-flash", "cn"), {
			kind: "trae",
			model: "deepseek-v4.1-flash",
		});
	});

	test("auto always routes Trae (never local)", async () => {
		const decider = makeDecider({
			localBase: () => "http://127.0.0.1:11434/v1",
		});
		assert.deepEqual(await decider("auto", "cn"), { kind: "trae", model: "auto" });
	});

	test("trailing slashes in localBase are normalized", async () => {
		const decider = makeDecider({ localBase: () => "http://127.0.0.1:11434/v1///" });
		const route = await decider("local@m", "cn");
		assert.equal(route.baseUrl, "http://127.0.0.1:11434/v1");
	});
});

describe("router — by-id policy", () => {
	test("model in local catalog → local", async () => {
		const decider = makeDecider({
			localBase: () => "http://127.0.0.1:11434/v1",
			hybridPolicy: () => "by-id",
		});
		// mock fetch to return the catalog
		const orig = globalThis.fetch;
		globalThis.fetch = async (url) => {
			assert.equal(url, "http://127.0.0.1:11434/v1/models");
			return { ok: true, json: async () => ({ data: [{ id: "qwen2.5:14b" }, { id: "llama3" }] }) };
		};
		try {
			const route = await decider("qwen2.5:14b", "cn");
			assert.equal(route.kind, "local");
			assert.equal(route.model, "qwen2.5:14b");
		} finally {
			globalThis.fetch = orig;
		}
	});

	test("model NOT in local catalog → Trae", async () => {
		const decider = makeDecider({
			localBase: () => "http://127.0.0.1:11434/v1",
			hybridPolicy: () => "by-id",
		});
		const orig = globalThis.fetch;
		globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: "qwen2.5:14b" }] }) });
		try {
			assert.deepEqual(await decider("deepseek-v4.1-flash", "cn"), { kind: "trae", model: "deepseek-v4.1-flash" });
		} finally {
			globalThis.fetch = orig;
		}
	});

	test("catalog fetch failure → fallback to Trae, never rejects", async () => {
		const decider = makeDecider({
			localBase: () => "http://127.0.0.1:11434/v1",
			hybridPolicy: () => "by-id",
		});
		const orig = globalThis.fetch;
		globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
		try {
			assert.deepEqual(await decider("qwen2.5:14b", "cn"), { kind: "trae", model: "qwen2.5:14b" });
		} finally {
			globalThis.fetch = orig;
		}
	});

	test("auto never routes local even if in local catalog", async () => {
		const decider = makeDecider({
			localBase: () => "http://127.0.0.1:11434/v1",
			hybridPolicy: () => "by-id",
		});
		const orig = globalThis.fetch;
		globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: "auto" }] }) });
		try {
			assert.deepEqual(await decider("auto", "cn"), { kind: "trae", model: "auto" });
		} finally {
			globalThis.fetch = orig;
		}
	});
});
