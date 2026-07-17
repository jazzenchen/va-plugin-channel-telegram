import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readBoundedResponse } from "../dist/bounded-response.js";
import { downloadTelegramFile } from "../dist/media-download.js";

test("rejects a declared oversized response before reading the body", async () => {
  let opened = false;
  const response = {
    headers: new Headers({ "content-length": "11" }),
    body: { getReader() { opened = true; throw new Error("body opened"); } },
  };

  await assert.rejects(() => readBoundedResponse(response, 10), /exceeds 10 bytes/);
  assert.equal(opened, false);
});

test("rejects a chunked response once its streamed bytes exceed the limit", async () => {
  const response = new Response(new Uint8Array([1, 2, 3, 4]));
  await assert.rejects(() => readBoundedResponse(response, 3), /exceeds 3 bytes/);
});

test("download diagnostics never log the bot token", async () => {
  const token = "123456:secret-bot-token";
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-media-test-"));
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stderr.write;
  let stderr = "";
  globalThis.fetch = async () => new Response(new Uint8Array([1]));
  process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
  try {
    await downloadTelegramFile({
      api: { getFile: async () => ({ file_path: "photos/file.jpg" }) },
      botToken: token,
      fileId: "file-id",
      cacheDir,
      chatId: "chat",
      messageId: "message",
      ext: ".jpg",
      mimeType: "image/jpeg",
      type: "image",
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.stderr.write = originalWrite;
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
  assert.equal(stderr.includes(token), false);
});
