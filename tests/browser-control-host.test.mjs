import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const TEST_TOKEN = "browser-control-test-token";
process.env.DSH_BROWSER_CONTROL_PORT = "0";
process.env.DSH_BROWSER_CONTROL_TOKEN = TEST_TOKEN;
process.env.DSH_BROWSER_CONTROL_COMMAND_TIMEOUT_MS = "2000";
process.env.DSH_BROWSER_CONTROL_STATE = join(mkdtempSync(join(tmpdir(), "dsh-bc-host-")), "state.json");
process.env.DSH_BROWSER_CONTROL_SHOT_DIR = join(mkdtempSync(join(tmpdir(), "dsh-bc-shots-")), "shots");

const plugin = await import("../index.js");

const EXPECTED_ACTIONS = ["open", "navigate", "snapshot", "click", "type", "key", "scroll", "wait", "status", "screenshot"];

function makeContext() {
  const tools = [];
  const disposers = [];
  const ctx = {
    effect(execute) {
      const dispose = execute();
      if (typeof dispose === "function") disposers.push(dispose);
      return dispose;
    },
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
    timer: {
      timeout() {
        return () => {};
      },
      interval() {
        return () => {};
      },
    },
  };
  return {
    ctx,
    tools,
    disposeAll() {
      for (const dispose of disposers.splice(0).reverse()) dispose();
    },
  };
}

test("host apply() is synchronous and registers the browser tool", () => {
  const harness = makeContext();
  assert.equal(plugin.apply(harness.ctx), undefined);
  assert.equal(harness.tools.length, 1);
  assert.equal(harness.tools[0].name, "browser");
  harness.disposeAll();
});

test("DS COMPAT: browser tool parameters are an object-rooted JSON Schema", () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  const tool = harness.tools[0];
  assert.equal(tool.parameters.type, "object");
  assert.deepEqual(tool.parameters.required, ["action"]);
  assert.deepEqual([...tool.parameters.properties.action.enum].sort(), [...EXPECTED_ACTIONS].sort());
  for (const [name, property] of Object.entries(tool.parameters.properties)) {
    assert.notEqual(property.required, true, `parameter "${name}" must not carry the dialect required flag`);
  }
  assert.equal(tool.output.schema.type, "object");
  assert.deepEqual(tool.output.schema.required, ["text"]);
  harness.disposeAll();
});

test("snapshot without a connected client returns an actionable message", async () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  try {
    const result = await harness.tools[0].execute({ action: "snapshot" });
    assert.match(result.text, /no connected client/i);
  } finally {
    harness.disposeAll();
  }
});

test("unknown actions are rejected", async () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  try {
    await assert.rejects(() => harness.tools[0].execute({ action: "dance" }));
  } finally {
    harness.disposeAll();
  }
});

test("tool commands round-trip through a fake client (open/snapshot/click)", async () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  let stopped = false;
  const received = [];
  let pollLoop;
  try {
    const port = await waitForPort(harness.tools[0]);
    const client = startFakeClient(port, received, () => stopped);
    pollLoop = client.promise;
    const open = await harness.tools[0].execute({ action: "open", url: "https://example.com/" });
    assert.match(open.text, /opened/i);
    const snapshot = await harness.tools[0].execute({ action: "snapshot" });
    assert.match(snapshot.text, /Example Domain/);
    assert.match(snapshot.text, /viewport: 575x742 scrollY=0/);
    assert.match(snapshot.text, /\[e0\] link "Learn more"/);
    assert.match(snapshot.text, /\[e1\] textbox "" .* = "hello"/);
    assert.match(snapshot.text, /— heading "Example Domain"/);
    assert.match(snapshot.text, /3 more elements not shown/);
    assert.match(snapshot.text, /action=scroll/);
    const click = await harness.tools[0].execute({ action: "click", ref: "e0" });
    assert.match(click.text, /click/i);
    const typed = await harness.tools[0].execute({ action: "type", text: "hi" });
    assert.match(typed.text, /focused value: "hi"/);
    const scrolled = await harness.tools[0].execute({ action: "scroll", deltaY: 300 });
    assert.match(scrolled.text, /scrollY 250/);
    const shot = await harness.tools[0].execute({ action: "screenshot" });
    assert.match(shot.text, /screenshot saved/);
    const shotPath = /screenshot saved: (.+?) \(/u.exec(shot.text)?.[1];
    assert.ok(shotPath, "screenshot text must contain a path");
    assert.equal(existsSync(shotPath), true, "the screenshot file must exist");
    assert.deepEqual(
      received.map((command) => command.type),
      ["open", "snapshot", "click", "type", "scroll", "screenshot"],
    );
  } finally {
    stopped = true;
    try {
      pollLoop?.catch(() => {});
    } catch {
      // ignore
    }
    harness.disposeAll();
  }
});

async function waitForPort(tool) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const status = JSON.parse((await tool.execute({ action: "status" })).text);
    if (status.listening && status.port > 0) return status.port;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("bridge did not start");
}

function startFakeClient(port, received, isStopped) {
  const answer = (command) => {
    switch (command.type) {
      case "open":
        return { ok: true, url: command.url };
      case "snapshot":
        return {
          ok: true,
          snapshot: {
            title: "Example Domain",
            url: "https://example.com/",
            viewport: { w: 575, h: 742, scrollY: 0 },
            elements: [
            { ref: "e0", role: "link", tag: "a", text: "Learn more", x: 120, y: 240, depth: 1 },
            { ref: "e1", role: "textbox", tag: "input", text: "", value: "hello", x: 10, y: 20, depth: 0 },
            { role: "heading", tag: "h1", text: "Example Domain", x: 200, y: 80, depth: 0 },
          ],
          omitted: 3,
          scroll: { scrollHeight: 2400, pagesBelow: 2 },
          },
        };
      case "click":
        return { ok: true };
      case "type":
        return { ok: true, typed: command.text, value: command.text, settle: { settled: true, mutations: 1 }, changed: true };
      case "key":
        return { ok: true, key: command.key, settle: { settled: true, mutations: 0 }, changed: false };
      case "scroll":
        return { ok: true, deltaY: command.deltaY, scrollY: 250, scrollHeight: 2400, innerHeight: 742 };
      case "screenshot":
        return { ok: true, dataUrl: "data:image/png;base64," + Buffer.from("fake-png-bytes").toString("base64") };
      default:
        return { ok: true };
    }
  };
  const promise = (async () => {
    while (!isStopped()) {
      try {
        const auth = { authorization: `Bearer ${TEST_TOKEN}` };
        const response = await fetch(`http://127.0.0.1:${port}/poll?client=fake`, { headers: auth });
        if (!response.ok) break;
        const message = await response.json();
        if (message && typeof message.id === "string" && message.cmd) {
          received.push(message.cmd);
          await fetch(`http://127.0.0.1:${port}/result?id=${encodeURIComponent(message.id)}`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify(answer(message.cmd)),
          });
        }
      } catch {
        if (isStopped()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  })();
  return { promise };
}

test("click receipt warns when the action produced no observable change", () => {
  const click = plugin.__test.formatResult("click", {
    x: 10,
    y: 20,
    label: "Covered",
    hitTrusted: true,
    navigated: false,
    changed: false,
    settle: { settled: true, mutations: 0 },
  });
  assert.match(click, /no observable change/);
  const covered = plugin.__test.formatResult("click", {
    x: 10,
    y: 20,
    label: "Covered",
    hitTrusted: false,
    navigated: false,
    changed: true,
    settle: { settled: true, mutations: 1 },
  });
  assert.match(covered, /appears covered/);
});
