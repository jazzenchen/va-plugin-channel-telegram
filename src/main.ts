#!/usr/bin/env node
/**
 * VibeAround Telegram Plugin — ACP Client
 *
 * Spawned by the Rust host as a child process.
 * Communicates via ACP protocol (JSON-RPC 2.0 over stdio).
 */

import { createRequire } from "node:module";

import { runChannelPlugin } from "@vibearound/plugin-channel-sdk";

import { TelegramBot } from "./bot.js";
import { AgentStreamHandler } from "./agent-stream.js";

const packageVersion = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

runChannelPlugin({
  name: "vibearound-telegram",
  version: packageVersion,
  requiredConfig: ["bot_token"],
  createBot: ({ config, agent, log, cacheDir, channelInstanceId, actorId }) =>
    new TelegramBot(
      { bot_token: config.bot_token as string },
      agent,
      log,
      cacheDir,
      channelInstanceId,
      actorId,
    ),
  afterCreate: async (bot, log) => {
    const botInfo = await bot.probe();
    log("info", `bot identity: @${botInfo.username} (${botInfo.id})`);
  },
  createRenderer: (bot, _log, verbose) =>
    new AgentStreamHandler(bot, verbose),
  // A successful getMe() does not prove long polling is still running.
  healthCheck: async (bot) => bot.isPolling(),
});
