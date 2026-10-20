// tests/local.test.js — unit tests for dsh-hybrid-connect local.js
// Run: node --test tests/

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { forwardToOpenAI } from "../local.js";

/** Minimal mock ServerResponse capturing writeHead / end / writes. */
function mockRes() {
	const state = { status: undefined, headers: undefined, chunks: [], ended: false, headersSent: false };
	return {
		state,
		writeHead(status, headers) {
			if (state.headersSent) throw new Error("ERR_HTTP_HEADERS_SENT");
			state.status = status;
			state.headers = headers;
			state.headersSent = true;
		},
		write(chunk) { state.chunks.push(String(chunk)); },
		end(chunk) { if (chunk !== undefined) state.chunks.push(String(chunk)); state.ended = true; },
		get headersSent() { return state.headersSent; },
	};
}

describe("local.js — forwardToOpenAI", () => {
	test("non-stream JSON: posts payload with swapped model, passes back upstream status+body", async () => {
		// Spin up a tiny local server
		const server = createServer((req, res) => {
			let body = "";
			req.on("data", (c) => { body += c; });
			req.on("end", () => {
				const parsed = JSON.parse(body);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ echo: parsed.model, ok: true }));
			});
		});
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		const port = server.address().port;
		try {
			const res = mockRes();
			await forwardToOpenAI(
				{ kind: "local", baseUrl: `http://127.0.0.1:${port}/v1`, key: "", model: "qwen2.5:14b" },
				{ model: "local@qwen2.5:14b", messages: [] },
				res,
				new AbortController().signal,
			);
			assert.equal(res.state.status, 200);
			const body = JSON.parse(res.state.chunks.join(""));
			assert.equal(body.echo, "qwen2.5:14b"); // prefix stripped, model swapped
			assert.equal(body.ok, true);
		} finally {
			server.close();
		}
	});

	test("key set → Authorization header attached", async () => {
		let sawAuth;
		const server = createServer((req, res) => {
			sawAuth = req.headers.authorization;
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end("{}");
		});
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		try {
			const res = mockRes();
			await forwardToOpenAI(
				{ kind: "local", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, key: "sk-abc", model: "m" },
				{ messages: [] },
				res,
				new AbortController().signal,
			);
			assert.equal(sawAuth, "Bearer sk-abc");
		} finally {
			server.close();
		}
	});

	test("unreachable local server → 502 with error JSON, does not throw", async () => {
		const res = mockRes();
		// Port with nothing listening (reserved, guaranteed refuse)
		await forwardToOpenAI(
			{ kind: "local", baseUrl: "http://127.0.0.1:1/v1", key: "", model: "m" },
			{ messages: [] },
			res,
			new AbortController().signal,
		);
		assert.equal(res.state.status, 502);
		const body = JSON.parse(res.state.chunks.join(""));
		assert.equal(body.error.type, "local_upstream_error");
	});

	test("upstream 404 → 404 model_not_found, does not throw", async () => {
		const server = createServer((req, res) => { res.writeHead(404); res.end("nope"); });
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		try {
			const res = mockRes();
			await forwardToOpenAI(
				{ kind: "local", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, key: "", model: "m" },
				{ messages: [] },
				res,
				new AbortController().signal,
			);
			assert.equal(res.state.status, 404);
			const body = JSON.parse(res.state.chunks.join(""));
			assert.equal(body.error.code, "model_not_found");
		} finally {
			server.close();
		}
	});

	test("SSE passthrough: relayed verbatim, ends cleanly", async () => {
		const server = createServer((req, res) => {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write('data: {"a":1}\n\n');
			res.write('data: {"b":2}\n\n');
			res.write("data: [DONE]\n\n");
			res.end();
		});
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		try {
			const res = mockRes();
			await forwardToOpenAI(
				{ kind: "local", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, key: "", model: "m" },
				{ stream: true, messages: [] },
				res,
				new AbortController().signal,
			);
			assert.equal(res.state.status, 200);
			const joined = res.state.chunks.join("");
			assert.ok(joined.includes('data: {"a":1}'));
			assert.ok(joined.includes("data: [DONE]"));
			assert.ok(res.state.ended);
		} finally {
			server.close();
		}
	});

	test("client abort while the local server never answers → request ends, does not hang", async () => {
		const server = createServer(() => { /* accept the connection, never respond */ });
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		try {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 50);
			const res = mockRes();
			await forwardToOpenAI(
				{ kind: "local", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, key: "", model: "m" },
				{ messages: [] },
				res,
				controller.signal,
			);
			assert.ok(res.state.ended);
		} finally {
			server.closeAllConnections?.();
			server.close();
		}
	});
});
