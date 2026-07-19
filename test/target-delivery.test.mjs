import assert from "node:assert/strict";
import test from "node:test";

import { AgentStreamHandler } from "../dist/agent-stream.js";

const target = {
  channelInstanceId: "telegram-primary",
  actorId: "telegram-bot",
  chatId: "-100123456",
  topicId: "42",
  replyTo: "1234",
};

function createRenderer(overrides = {}) {
  const sends = [];
  const telegramBot = {
    bot: {
      api: {
        async sendMessage(...args) {
          if (overrides.sendMessage) return overrides.sendMessage(...args);
          sends.push(args);
          return { message_id: 9876 };
        },
        async editMessageText(...args) {
          if (overrides.editMessageText) return overrides.editMessageText(...args);
        },
      },
    },
  };
  return {
    renderer: new AgentStreamHandler(telegramBot),
    sends,
  };
}

test("Telegram maps topicId and replyTo onto every new message", async () => {
  const { renderer, sends } = createRenderer();

  await renderer.sendText(target, "system");
  await renderer.sendBlock(target, "text", "answer");

  for (const [, , options] of sends) {
    assert.deepEqual(options, {
      message_thread_id: 42,
      reply_parameters: { message_id: 1234 },
    });
  }
});
test("Telegram permission buttons preserve the active target", async () => {
  const { renderer, sends } = createRenderer();

  await renderer.onRequestPermission(
    target,
    {
      sessionId: "session-1",
      options: [{ kind: "allow_once", optionId: "allow", name: "Allow" }],
    },
    "callback-1",
  );

  assert.deepEqual(sends[0][2], {
    message_thread_id: 42,
    reply_parameters: { message_id: 1234 },
    reply_markup: {
      inline_keyboard: [[{
        text: "Allow",
        callback_data: "va_perm:callback-1:allow",
      }]],
    },
  });
});

test("Telegram transport failures reject block delivery", async () => {
  const sendFailure = new Error("Telegram send failed");
  const editFailure = new Error("Telegram edit failed");
  const sendRenderer = createRenderer({
    sendMessage: async () => { throw sendFailure; },
  }).renderer;
  const editRenderer = createRenderer({
    editMessageText: async () => { throw editFailure; },
  }).renderer;

  await assert.rejects(
    sendRenderer.sendBlock(target, "text", "answer"),
    sendFailure,
  );
  await assert.rejects(
    editRenderer.editBlock(target, 9876, "text", "updated", true),
    editFailure,
  );
});
