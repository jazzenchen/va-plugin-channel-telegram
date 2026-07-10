import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeTelegramPromptText,
  shouldHandleTelegramInbound,
} from "../dist/inbound-policy.js";

const base = { botId: 42, botUsername: "VibeAroundBot" };

test("private messages do not require a mention", () => {
  assert.equal(shouldHandleTelegramInbound({ ...base, chatType: "private", entities: [] }), true);
});

test("ordinary group messages are ignored", () => {
  assert.equal(shouldHandleTelegramInbound({ ...base, chatType: "group", entities: [] }), false);
});

test("username and text mentions must identify the current bot", () => {
  assert.equal(shouldHandleTelegramInbound({
    ...base,
    chatType: "supergroup",
    entities: [{ type: "mention", text: "@vibearoundbot" }],
  }), true);
  assert.equal(shouldHandleTelegramInbound({
    ...base,
    chatType: "group",
    entities: [{ type: "text_mention", text: "VibeAround", user: { id: 42 } }],
  }), true);
  assert.equal(shouldHandleTelegramInbound({
    ...base,
    chatType: "group",
    entities: [{ type: "mention", text: "@OtherBot" }],
  }), false);
});

test("platform-recognized slash commands remain valid in groups", () => {
  assert.equal(shouldHandleTelegramInbound({
    ...base,
    chatType: "group",
    entities: [{ type: "bot_command", text: "/new" }],
  }), true);
  assert.equal(shouldHandleTelegramInbound({
    ...base,
    chatType: "group",
    entities: [{ type: "bot_command", text: "/new@VibeAroundBot" }],
  }), true);
  assert.equal(shouldHandleTelegramInbound({
    ...base,
    chatType: "group",
    entities: [{ type: "bot_command", text: "/new@OtherBot" }],
  }), false);
});

test("bot addressing is removed from the agent prompt", () => {
  assert.equal(normalizeTelegramPromptText("@VibeAroundBot hello", base.botUsername), "hello");
  assert.equal(normalizeTelegramPromptText("/new@VibeAroundBot project", base.botUsername), "/new project");
});
