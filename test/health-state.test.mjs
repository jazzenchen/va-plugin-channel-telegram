import assert from "node:assert/strict";
import test from "node:test";

import { TelegramBot } from "../dist/bot.js";

test("start returns the long-polling lifetime promise", async () => {
  const bot = Object.create(TelegramBot.prototype);
  const failure = new Error("polling failed");
  const startResult = Promise.reject(failure);
  bot.bot = { start: () => startResult };

  assert.equal(bot.start(), startResult);
  await assert.rejects(startResult, failure);
});

test("health follows grammY polling state", () => {
  const bot = Object.create(TelegramBot.prototype);
  let running = false;
  bot.bot = { isRunning: () => running };

  assert.equal(bot.isPolling(), false);
  running = true;
  assert.equal(bot.isPolling(), true);
});
