import { mkdtempSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBridge } from "../bridge.js";

const tempState = () => join(mkdtempSync(join(tmpdir(), "dsh-bridge-test-")), "state.json");
const TOKEN = "test-token";

function makeBridge(overrides = {}) {
  return createBridge({
    port: 0,
    token: TOKEN,
    stateFile: tempState(),
    pollTimeoutMs: 150,
    commandTimeoutMs: 1000,
    ...overrides,
  });
}

/** fetch helper that sends the bearer token unless the test overrides it. */
function authed(port, path, init = {}, token = TOKEN) {
  const headers = { ...(init.headers ?? {}) };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers });
}

/** Raw node:http request, needed to set forbidden headers such as Host. */
function rawRequest(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path, method, headers: { ...headers, ...(body === undefined ? {} : { "content-length": Buffer.byteLength(body) }) } },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text }));
      },
    );
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

test("bridge: rejects a request without the bearer token", async () => {
  const bridge = makeBridge();
  const port = await bridge.start();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/hello`);
    assert.equal(response.status, 401);
  } finally {
    bridge.close();
  }
});

test("bridge: ignores a token in the query string (header only)", async () => {
  const bridge = makeBridge();
  const port = await bridge.start();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/hello?token=${TOKEN}`);
    assert.equal(response.status, 401);
  } finally {
    bridge.close();
  }
});

test("bridge: answers /hello with a valid bearer token", async () => {
  const bridge = makeBridge();
  const port = await bridge.start();
  try {
    const response = await authed(port, "/hello");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.port, port);
  } finally {
    bridge.close();
  }
});

test("bridge: rejects a foreign Host header (DNS rebinding)", async () => {
  const bridge = makeBridge();
  const port = await bridge.start();
  try {
    const response = await rawRequest(port, "/hello", {
      headers: { host: "evil.example", authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 403);
    assert.equal(bridge.sticky.lastRejectedHost, "evil.example");
  } finally {
    bridge.close();
  }
});

test("bridge: rejects a foreign browser origin", async () => {
  const bridge = makeBridge();
  const port = await bridge.start();
  try {
    const response = await rawRequest(port, "/hello", {
      headers: { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" },
    });
    assert.equal(response.status, 403);
    assert.equal(bridge.sticky.lastRejectedOrigin, "https://evil.example");
  } finally {
    bridge.close();
  }
});

test("bridge: allows the DSH renderer origin and echoes it in CORS", async () => {
  const bridge = makeBridge();
  const port = await bridge.start();
  try {
    const response = await rawRequest(port, "/hello", {
      headers: { authorization: `Bearer ${TOKEN}`, origin: "dsh-app://app" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers["access-control-allow-origin"], "dsh-app://app");
    assert.match(String(response.headers.vary ?? ""), /Origin/i);
  } finally {
    bridge.close();
  }
});

test("bridge: preflight from an allowed origin permits the authorization header", async () => {
  const bridge = makeBridge();
  const port = await bridge.start();
  try {
    const response = await rawRequest(port, "/poll", {
      method: "OPTIONS",
      headers: {
        origin: "dsh-app://app",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers["access-control-allow-origin"], "dsh-app://app");
    assert.match(String(response.headers["access-control-allow-headers"]), /authorization/i);
  } finally {
    bridge.close();
  }
});

test("bridge: preflight from a foreign origin is rejected", async () => {
  const bridge = makeBridge();
  const port = await bridge.start();
  try {
    const response = await rawRequest(port, "/poll", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
    });
    assert.equal(response.status, 403);
  } finally {
    bridge.close();
  }
});

test("bridge: a command pushed before a poll is delivered to that poll", async () => {
  const bridge = makeBridge({ pollTimeoutMs: 500 });
  const port = await bridge.start();
  try {
    const pollPromise = authed(port, "/poll?client=c1").then((r) => r.json());
    await new Promise((resolve) => setTimeout(resolve, 30));
    const commandPromise = bridge.pushCommand({ type: "ping" });
    const delivered = await pollPromise;
    assert.ok(delivered.id, "poll must carry a command id");
    assert.deepEqual(delivered.cmd, { type: "ping" });
    const result = await authed(port, `/result?id=${encodeURIComponent(delivered.id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, pong: true }),
    });
    assert.equal(result.status, 200);
    const outcome = await commandPromise;
    assert.equal(outcome.value.pong, true);
    assert.ok(outcome.latencyMs >= 0);
  } finally {
    bridge.close();
  }
});

test("bridge: a multi-megabyte result body is accepted (regression: fullPage PNG)", async () => {
  const bridge = makeBridge({ pollTimeoutMs: 500 });
  const port = await bridge.start();
  try {
    const pollPromise = authed(port, "/poll?client=c1").then((r) => r.json());
    await new Promise((resolve) => setTimeout(resolve, 30));
    const commandPromise = bridge.pushCommand({ type: "screenshot" });
    const delivered = await pollPromise;
    // Real fullPage PNGs of external sites base64-encode to several MB; the old
    // 1 MB body cap silently dropped them and the Host only saw a timeout.
    const dataUrl = `data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}`;
    const result = await authed(port, `/result?id=${encodeURIComponent(delivered.id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, dataUrl }),
    });
    assert.equal(result.status, 200);
    const outcome = await commandPromise;
    assert.equal(outcome.value.dataUrl.length, dataUrl.length);
  } finally {
    bridge.close();
  }
});

test("bridge: an over-limit result body is rejected with 413 and recorded", async () => {
  const bridge = makeBridge({ pollTimeoutMs: 500, maxResultBodyBytes: 1000 });
  const port = await bridge.start();
  try {
    const pollPromise = authed(port, "/poll?client=c1").then((r) => r.json());
    await new Promise((resolve) => setTimeout(resolve, 30));
    const commandPromise = bridge.pushCommand({ type: "screenshot" }, 300);
    const delivered = await pollPromise;
    const result = await authed(port, `/result?id=${encodeURIComponent(delivered.id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, padding: "x".repeat(5000) }),
    });
    assert.equal(result.status, 413);
    assert.equal(bridge.sticky.lastRejectedBody?.path, "/result");
    assert.ok(bridge.sticky.lastRejectedBody?.receivedBytes > 1000);
    // The dropped result must still surface as a command timeout, not a hang.
    await assert.rejects(() => commandPromise, /no client result before timeout/);
  } finally {
    bridge.close();
  }
});

test("bridge: /diag appends sticky diagnostics", async () => {
  const bridge = makeBridge();
  const port = await bridge.start();
  try {
    const response = await authed(port, "/diag", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: "unit", value: { ok: true } }),
    });
    assert.equal(response.status, 200);
    assert.equal(bridge.sticky.diags.length, 1);
    assert.equal(bridge.sticky.diags[0].tag, "unit");
  } finally {
    bridge.close();
  }
});

test("bridge: a command goes to the newest registered client only", async () => {
  const bridge = makeBridge({ pollTimeoutMs: 500 });
  const port = await bridge.start();
  try {
    // The older client starts polling first and keeps a poll open.
    const oldPollPromise = authed(port, "/poll?client=old").then((r) => r.json());
    await new Promise((resolve) => setTimeout(resolve, 40));
    const newPollPromise = authed(port, "/poll?client=new").then((r) => r.json());
    await new Promise((resolve) => setTimeout(resolve, 40));
    const commandPromise = bridge.pushCommand({ type: "ping" });
    const delivered = await newPollPromise;
    const rejected = await oldPollPromise;
    assert.deepEqual(delivered.cmd, { type: "ping" });
    assert.equal(rejected.id, undefined, "the stale client must not receive the command");
    // Settle the command so the test does not leave it pending.
    await authed(port, `/result?id=${encodeURIComponent(delivered.id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    });
    await commandPromise;
  } finally {
    bridge.close();
  }
});

test("bridge: closing ends a held long-poll instead of hanging the process", async () => {
  const bridge = makeBridge({ pollTimeoutMs: 60_000 });
  const port = await bridge.start();
  const pollPromise = authed(port, "/poll?client=held").then((r) => r.json());
  await new Promise((resolve) => setTimeout(resolve, 50));
  bridge.close();
  const payload = await pollPromise;
  assert.equal(payload.id, undefined);
});

test("bridge: pending command settles when the bridge closes", async () => {
  const bridge = makeBridge({ commandTimeoutMs: 60_000 });
  await bridge.start();
  const pending = bridge.pushCommand({ type: "never-answered" });
  bridge.close();
  const outcome = await pending;
  assert.equal(outcome.value.ok, false);
});

test("bridge: a timed-out queued command is never replayed into a later poll", async () => {
  const bridge = makeBridge({ commandTimeoutMs: 80, pollTimeoutMs: 300 });
  const port = await bridge.start();
  try {
    await assert.rejects(() => bridge.pushCommand({ type: "stale" }), /timeout/);
    assert.equal(bridge.queue.length, 0, "the timeout must remove the queued command");
    const response = await authed(port, "/poll?client=late");
    const payload = await response.json();
    assert.equal(payload.id, undefined, "a later panel must not receive the expired command");
  } finally {
    bridge.close();
  }
});

test("bridge: a per-command timeout override expires sooner than the bridge-wide timeout", async () => {
  const bridge = makeBridge({ commandTimeoutMs: 60_000 });
  await bridge.start();
  try {
    const started = Date.now();
    await assert.rejects(() => bridge.pushCommand({ type: "slow-batch" }, 80), /timeout/);
    assert.ok(Date.now() - started < 5000, "the override must not wait for the bridge-wide timeout");
    assert.equal(bridge.queue.length, 0);
    assert.equal(bridge.pending.size, 0);
  } finally {
    bridge.close();
  }
});

test("bridge: a per-command timeout override also extends the stale queue window", async () => {
  const bridge = makeBridge({ commandTimeoutMs: 80, pollTimeoutMs: 500 });
  const port = await bridge.start();
  try {
    const pending = bridge.pushCommand({ type: "qa-step" }, 5000);
    // Older than the bridge-wide 80ms timeout: without the override the /poll
    // age filter would drop it as stale.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const response = await authed(port, "/poll?client=qa");
    const payload = await response.json();
    assert.deepEqual(payload.cmd, { type: "qa-step" }, "the override must keep the command deliverable");
    await authed(port, `/result?id=${encodeURIComponent(payload.id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, settled: true }),
    });
    const outcome = await pending;
    assert.equal(outcome.value.ok, true);
  } finally {
    bridge.close();
  }
});
