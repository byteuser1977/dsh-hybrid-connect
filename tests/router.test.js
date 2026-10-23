// tests/router.test.js — unit tests for dsh-hybrid-connect router.js
// Run: node --test

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

describe("router — by-id catalog caching", () => {
	test("successful fetch is reused within the TTL (one fetch across calls)", async () => {
		let calls = 0;
		const decider = makeDecider({
			localBase: () => "http://127.0.0.1:11434/v1",
			hybridPolicy: () => "by-id",
		});
		const orig = globalThis.fetch;
		globalThis.fetch = async () => {
			calls++;
			return { ok: true, json: async () => ({ data: [{ id: "qwen2.5:14b" }] }) };
		};
		try {
			assert.equal((await decider("qwen2.5:14b", "cn")).kind, "local");
			assert.equal((await decider("qwen2.5:14b", "cn")).kind, "local");
			assert.equal(calls, 1);
		} finally {
			globalThis.fetch = orig;
		}
	});

	test("failed fetch enters a cooldown: no re-fetch per request while the local server is down", async () => {
		let calls = 0;
		const decider = makeDecider({
			localBase: () => "http://127.0.0.1:11434/v1",
			hybridPolicy: () => "by-id",
		});
		const orig = globalThis.fetch;
		globalThis.fetch = async () => {
			calls++;
			throw new Error("ECONNREFUSED");
		};
		try {
			// The first request pays one failing probe; every further request
			// inside the cooldown window must reuse that verdict without
			// re-probing, or an offline local server stalls the Trae path.
			assert.deepEqual(await decider("qwen2.5:14b", "cn"), { kind: "trae", model: "qwen2.5:14b" });
			assert.deepEqual(await decider("qwen2.5:14b", "cn"), { kind: "trae", model: "qwen2.5:14b" });
			assert.deepEqual(await decider("deepseek-v4.1-flash", "cn"), { kind: "trae", model: "deepseek-v4.1-flash" });
			assert.equal(calls, 1);
		} finally {
			globalThis.fetch = orig;
		}
	});

	test("after the cooldown elapses the catalog is probed again", async () => {
		let calls = 0;
		const decider = makeDecider({
			localBase: () => "http://127.0.0.1:11434/v1",
			hybridPolicy: () => "by-id",
		});
		const orig = globalThis.fetch;
		globalThis.fetch = async () => {
			calls++;
			if (calls === 1) throw new Error("ECONNREFUSED");
			return { ok: true, json: async () => ({ data: [{ id: "qwen2.5:14b" }] }) };
		};
		// Start the mocked clock at a realistic epoch so the initial state
		// (failedAt = 0) cannot read as "inside the cooldown window".
		mock.timers.enable({ apis: ["Date"], now: 1_759_000_000_000 });
		try {
			assert.deepEqual(await decider("qwen2.5:14b", "cn"), { kind: "trae", model: "qwen2.5:14b" });
			// Still inside the cooldown window: no re-probe.
			mock.timers.tick(10_000);
			assert.deepEqual(await decider("qwen2.5:14b", "cn"), { kind: "trae", model: "qwen2.5:14b" });
			assert.equal(calls, 1);
			// Cooldown elapsed: probe again, now the server is up.
			mock.timers.tick(21_000);
			assert.equal((await decider("qwen2.5:14b", "cn")).kind, "local");
			assert.equal(calls, 2);
		} finally {
			mock.timers.reset();
			globalThis.fetch = orig;
		}
	});

	test("concurrent by-id requests coalesce onto one catalog fetch", async () => {
		let calls = 0;
		const decider = makeDecider({
			localBase: () => "http://127.0.0.1:11434/v1",
			hybridPolicy: () => "by-id",
		});
		const orig = globalThis.fetch;
		globalThis.fetch = async () => {
			calls++;
			await new Promise((r) => setTimeout(r, 20));
			return { ok: true, json: async () => ({ data: [{ id: "qwen2.5:14b" }] }) };
		};
		try {
			const results = await Promise.all([
				decider("qwen2.5:14b", "cn"),
				decider("qwen2.5:14b", "cn"),
				decider("qwen2.5:14b", "cn"),
			]);
			assert.ok(results.every((route) => route.kind === "local"));
			assert.equal(calls, 1);
		} finally {
			globalThis.fetch = orig;
		}
	});

	test("editing localBase voids the cached catalog (old base must not answer for the new one)", async () => {
		let base = "http://127.0.0.1:11434/v1";
		let calls = 0;
		const seenUrls = [];
		const decider = makeDecider({
			localBase: () => base,
			hybridPolicy: () => "by-id",
		});
		const orig = globalThis.fetch;
		globalThis.fetch = async (url) => {
			calls++;
			seenUrls.push(String(url));
			return { ok: true, json: async () => ({ data: [{ id: "qwen2.5:14b" }] }) };
		};
		try {
			assert.equal((await decider("qwen2.5:14b", "cn")).kind, "local");
			base = "http://127.0.0.1:8000/v1";
			assert.equal((await decider("qwen2.5:14b", "cn")).kind, "local");
			assert.equal(calls, 2);
			assert.deepEqual(seenUrls, [
				"http://127.0.0.1:11434/v1/models",
				"http://127.0.0.1:8000/v1/models",
			]);
		} finally {
			globalThis.fetch = orig;
		}
	});
});
