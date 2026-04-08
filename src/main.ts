#!/usr/bin/env node
/**
 * VibeAround Telegram Plugin — ACP Client
 *
 * Spawned by the Rust host as a child process.
 * Communicates via ACP protocol (JSON-RPC 2.0 over stdio).
 */

import { runChannelPlugin } from "@vibearound/plugin-channel-sdk";

import { TelegramBot } from "./bot.js";
import { AgentStreamHandler } from "./agent-stream.js";

runChannelPlugin({
  name: "vibearound-telegram",
  version: "0.1.0",
  requiredConfig: ["bot_token"],
  createBot: ({ config, agent, log, cacheDir }) =>
    new TelegramBot(
      { bot_token: config.bot_token as string },
      agent,
      log,
      cacheDir,
    ),
  afterCreate: async (bot, log) => {
    const botInfo = await bot.probe();
    log("info", `bot identity: @${botInfo.username} (${botInfo.id})`);
  },
  createStreamHandler: (bot, log, verbose) =>
    new AgentStreamHandler(bot, log, verbose),
});
