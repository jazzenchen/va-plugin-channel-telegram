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
  createRenderer: (bot, log, verbose) =>
    new AgentStreamHandler(bot, log, verbose),
  // Heartbeat health check — bot.api.getMe() exercises the Telegram HTTPS
  // connection. Failing = skip heartbeat = host watchdog will restart us.
  healthCheck: async (bot) => {
    try {
      await bot.bot.api.getMe();
      return true;
    } catch {
      return false;
    }
  },
});
