import assert from "node:assert/strict";
import test from "node:test";

import { AgentStreamHandler } from "../dist/agent-stream.js";
import { TelegramBot } from "../dist/bot.js";

const target = {
  channelInstanceId: "telegram-primary",
  actorId: "telegram-bot",
  chatId: "-100123456",
  topicId: "42",
  replyTo: "1234",
};

function createRenderer(overrides = {}) {
  const sends = [];
  const documents = [];
  const edits = [];
  let nextMessageId = 9876;
  const telegramBot = {
    bot: {
      api: {
        async sendMessage(...args) {
          if (overrides.sendMessage) return overrides.sendMessage(...args);
          sends.push(args);
          return { message_id: nextMessageId++ };
        },
        async editMessageText(...args) {
          if (overrides.editMessageText) return overrides.editMessageText(...args);
          edits.push(args);
        },
        async sendDocument(...args) {
          if (overrides.sendDocument) return overrides.sendDocument(...args);
          documents.push(args);
        },
      },
    },
  };
  return {
    renderer: new AgentStreamHandler(telegramBot),
    sends,
    documents,
    edits,
  };
}

test("Telegram uploads files with the active reply target", async () => {
  const { renderer, documents } = createRenderer();

  await renderer.sendFile(target, {
    path: "/workspace/report.pdf",
    name: "report.pdf",
  });

  assert.equal(documents[0][0], -100123456);
  assert.equal(documents[0][1].filename, "report.pdf");
  assert.deepEqual(documents[0][2], {
    message_thread_id: 42,
    reply_parameters: { message_id: 1234 },
  });
});

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
    editRenderer.editBlock(
      target,
      { messages: [{ messageId: 9876, content: "answer" }] },
      "text",
      "updated",
      true,
    ),
    editFailure,
  );
});

test("Telegram generic callback delivery failures reach the bot error boundary", async () => {
  const failure = new Error("callback delivery failed");
  const answerFailure = new Error("callback answer failed");
  const answers = [];
  const bot = Object.create(TelegramBot.prototype);
  bot.agent = {
    async extNotification() {
      throw failure;
    },
  };
  bot.channelInstanceId = "telegram-primary";
  bot.actorId = "telegram-bot";

  await assert.rejects(
    bot.handleCallbackQuery({
      callbackQuery: {
        id: "callback-1",
        data: "action-1",
        from: { id: 42, first_name: "Test" },
        message: {
          message_id: 1234,
          chat: { id: -100123456, type: "group" },
        },
      },
      answerCallbackQuery: async (answer) => {
        answers.push(answer);
        throw answerFailure;
      },
    }),
    failure,
  );
  assert.deepEqual(answers, [{ text: "Action failed. Please try again." }]);
});

test("Telegram splits plain and initial block messages by Unicode characters", async () => {
  const systemText = "🙂".repeat(4097);
  const blockText = `${"甲".repeat(4096)}${"🙂".repeat(4097)}`;
  const systemDelivery = createRenderer();
  const blockDelivery = createRenderer();

  await systemDelivery.renderer.sendText(target, systemText);
  const ref = await blockDelivery.renderer.sendBlock(target, "text", blockText);

  assert.equal(systemDelivery.sends.map(([, text]) => text).join(""), systemText);
  assert.equal(blockDelivery.sends.map(([, text]) => text).join(""), blockText);
  assert.deepEqual(
    ref.messages.map(({ messageId }) => messageId),
    [9876, 9877, 9878],
  );
  for (const [, text, options] of [
    ...systemDelivery.sends,
    ...blockDelivery.sends,
  ]) {
    assert.ok(Array.from(text).length <= 4096);
    assert.deepEqual(options, {
      message_thread_id: 42,
      reply_parameters: { message_id: 1234 },
    });
  }
});

test("Telegram streaming edits existing segments and appends new ones", async () => {
  const { renderer, sends, edits } = createRenderer();
  const firstPart = "A".repeat(4096);
  const ref = await renderer.sendBlock(target, "text", firstPart);
  assert.ok(ref);

  const twoParts = `${firstPart}B`;
  await renderer.editBlock(target, ref, "text", twoParts, false);
  assert.deepEqual(
    ref.messages.map(({ messageId }) => messageId),
    [9876, 9877],
  );
  assert.equal(edits.length, 0);

  const threeParts = `${firstPart}${"B".repeat(4096)}C`;
  await renderer.editBlock(target, ref, "text", threeParts, true);
  assert.deepEqual(
    ref.messages.map(({ messageId }) => messageId),
    [9876, 9877, 9878],
  );
  assert.equal(edits.length, 1);
  assert.equal(edits[0][1], 9877);
  assert.equal(ref.messages.map(({ content }) => content).join(""), threeParts);
  assert.deepEqual(sends[1][2], sends[0][2]);
  assert.deepEqual(sends[2][2], sends[0][2]);
  for (const { content } of ref.messages) {
    assert.ok(Array.from(content).length <= 4096);
  }
});
