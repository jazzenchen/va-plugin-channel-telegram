import assert from "node:assert/strict";
import test from "node:test";

import { createTelegramCallbackContext } from "../dist/route-context.js";

test("Telegram callback metadata preserves the extended route", () => {
  assert.deepEqual(
    createTelegramCallbackContext({
      channelInstanceId: "telegram-primary",
      actorId: "codex-reviewer",
      chatId: "-100123456",
      topicId: "42",
      senderId: "987654",
      platformMessageId: "1234",
      scope: "group",
    }),
    {
      channelInstanceId: "telegram-primary",
      actorId: "codex-reviewer",
      chatId: "-100123456",
      topicId: "42",
      senderId: "987654",
      platformMessageId: "1234",
      scope: "group",
      addressedBy: "callback",
    },
  );
});
