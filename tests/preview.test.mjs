/** Static preview server: token gating, path traversal, MIME, GET/HEAD, dispose. */
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPreviewServer, mimeTypeFor } from "../lib/preview.js";

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-preview-"));
  mkdirSync(join(dir, "assets"));
  mkdirSync(join(dir, "empty"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Preview Home</title><h1>home</h1>");
  writeFileSync(join(dir, "page.html"), "<!doctype html><title>Preview Page</title>");
  writeFileSync(join(dir, "assets", "app.css"), "body{color:#111}");
  writeFileSync(join(dir, "assets", "app.js"), "window.__preview = true;");
  writeFileSync(join(dir, "assets", "data.json"), '{"ok":true}');
  writeFileSync(join(dir, "index.htm"), "htm fallback");
  return dir;
}

async function withServer(options, run) {
  const server = await createPreviewServer({ port: 0, ...options });
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

async function get(url, init) {
  const response = await fetch(url, init);
  const body = await response.text();
  return { status: response.status, headers: response.headers, body };
}

test("preview: serves index.html at the tokenized root with a html content type", async () => {
  const dir = makeFixture();
  await withServer({ dir }, async (server) => {
    assert.equal(server.host, "127.0.0.1", "the server must bind loopback only");
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/, "URL must carry a random token prefix");
    const page = await get(server.url);
    assert.equal(page.status, 200);
    assert.match(String(page.headers.get("content-type")), /text\/html/);
    assert.match(page.body, /Preview Home/);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  });
});

test("preview: serves nested files with MIME types and supports HEAD", async () => {
  const dir = makeFixture();
  await withServer({ dir }, async (server) => {
    const css = await get(`${server.url}assets/app.css`);
    assert.equal(css.status, 200);
    assert.match(String(css.headers.get("content-type")), /text\/css/);
    assert.match(css.body, /color:#111/);
    assert.equal(mimeTypeFor(join(dir, "assets", "app.js")), "text/javascript; charset=utf-8");
    assert.equal(mimeTypeFor(join(dir, "assets", "data.json")), "application/json; charset=utf-8");
    const head = await fetch(`${server.url}page.html`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.match(String(head.headers.get("content-type")), /text\/html/);
    assert.equal(await head.text(), "", "HEAD must not return a body");
    assert.ok(Number(head.headers.get("content-length")) > 0);
  });
});

test("preview: rejects paths outside the token prefix", async () => {
  const dir = makeFixture();
  await withServer({ dir }, async (server) => {
    const root = server.address();
    const noToken = await get(`${root}/index.html`);
    assert.equal(noToken.status, 404);
    const wrongToken = await get(`${root}/deadbeef/index.html`);
    assert.equal(wrongToken.status, 404);
  });
});

test("preview: blocks path traversal, encoded traversal and backslash escapes", async () => {
  const parent = mkdtempSync(join(tmpdir(), "dsh-preview-outside-"));
  writeFileSync(join(parent, "secret.txt"), "TOP-SECRET");
  const dir = join(parent, "www");
  mkdirSync(dir);
  writeFileSync(join(dir, "index.html"), "<title>ok</title>");
  await withServer({ dir }, async (server) => {
    const attempts = [
      `${server.url}../secret.txt`,
      `${server.url}%2e%2e%2fsecret.txt`,
      `${server.url}..%2Fsecret.txt`,
      `${server.url}%2e%2e%5csecret.txt`,
      `${server.url}assets/../../secret.txt`,
      `${server.url}..%252fsecret.txt`,
      `${server.url}..\\secret.txt`,
    ];
    for (const attempt of attempts) {
      const response = await fetch(attempt).catch(() => undefined);
      if (response === undefined) continue;
      const body = await response.text();
      assert.notEqual(response.status, 200, `traversal must not succeed: ${attempt}`);
      assert.equal(body.includes("TOP-SECRET"), false, `secret leaked: ${attempt}`);
    }
    const ordinary = await get(`${server.url}index.html`);
    assert.equal(ordinary.status, 200);
  });
});

test("preview: no directory listing; empty directory is a 404", async () => {
  const dir = makeFixture();
  await withServer({ dir }, async (server) => {
    const empty = await get(`${server.url}empty/`);
    assert.equal(empty.status, 404, "a directory without index.html must not be listed");
    assert.equal(empty.body.includes("index of"), false);
    const assets = await get(`${server.url}assets/`);
    assert.equal(assets.status, 404);
    const missing = await get(`${server.url}nope.html`);
    assert.equal(missing.status, 404);
  });
});

test("preview: file option serves that file at the base URL", async () => {
  const dir = makeFixture();
  await withServer({ dir, file: "page.html" }, async (server) => {
    assert.match(server.url, /page\.html$/);
    const page = await get(server.url);
    assert.equal(page.status, 200);
    assert.match(page.body, /Preview Page/);
  });
});

test("preview: rejects a file outside the served directory and a missing directory", async () => {
  const dir = makeFixture();
  await assert.rejects(() => createPreviewServer({ dir, file: "../outside.html" }), /not inside/i);
  await assert.rejects(() => createPreviewServer({ dir: join(dir, "does-not-exist") }), /cannot serve/i);
  await assert.rejects(() => createPreviewServer({ dir: join(dir, "index.html") }), /cannot serve/i);
});

test("preview: only GET/HEAD are allowed", async () => {
  const dir = makeFixture();
  await withServer({ dir }, async (server) => {
    const response = await fetch(server.url, { method: "POST", body: "x" });
    assert.equal(response.status, 405);
    assert.match(String(response.headers.get("allow")), /GET/);
  });
});

test("preview: two servers get different random tokens, and close() frees the port", async () => {
  const dir = makeFixture();
  const first = await createPreviewServer({ dir });
  const second = await createPreviewServer({ dir });
  try {
    assert.notEqual(first.token, second.token);
    assert.notEqual(first.url, second.url);
    assert.equal((await get(first.url)).status, 200);
  } finally {
    await first.close();
    await second.close();
  }
  await assert.rejects(() => fetch(first.url), /fetch failed|ECONNREFUSED|connect/i);
  // close() is idempotent.
  await first.close();
});

test("preview: non-ASCII and space file names are served, unknown extensions fall back to octet-stream", async () => {
  const dir = makeFixture();
  writeFileSync(join(dir, "中文 页面.html"), "<title>中文</title>");
  writeFileSync(join(dir, "blob.bin"), Buffer.from([1, 2, 3, 4]));
  await withServer({ dir }, async (server) => {
    const page = await get(`${server.url}${encodeURIComponent("中文 页面.html")}`);
    assert.equal(page.status, 200);
    assert.match(page.body, /中文/);
    const blob = await fetch(`${server.url}blob.bin`);
    assert.equal(blob.status, 200);
    assert.equal(blob.headers.get("content-type"), "application/octet-stream");
  });
});

test("preview: refuses a file larger than the in-memory serve cap instead of OOMing the Host", async () => {
  const dir = makeFixture();
  const big = join(dir, "big.bin");
  // Sparse file: no 64 MiB allocation, but statSync reports the full size.
  const fd = openSync(big, "w");
  try {
    ftruncateSync(fd, 64 * 1024 * 1024 + 1);
  } finally {
    closeSync(fd);
  }
  await withServer({ dir }, async (server) => {
    const response = await fetch(`${server.url}big.bin`);
    assert.equal(response.status, 413);
    assert.match(await response.text(), /too large/i);
    assert.equal((await get(`${server.url}index.html`)).status, 200, "small files still work");
  });
});
