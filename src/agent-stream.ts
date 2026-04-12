/**
 * Telegram stream renderer — extends BlockRenderer with Telegram-specific transport.
 * TRef = number (Telegram message ID).
 */

import {
  BlockRenderer,
  type BlockKind,
  type VerboseConfig,
} from "@vibearound/plugin-channel-sdk";
import type { TelegramBot } from "./bot.js";

type LogFn = (level: string, msg: string) => void;

export class AgentStreamHandler extends BlockRenderer<number> {
  private telegramBot: TelegramBot;
  private log: LogFn;

  constructor(telegramBot: TelegramBot, log: LogFn, verbose?: Partial<VerboseConfig>) {
    super({
      streaming: true,
      flushIntervalMs: 500,
      minEditIntervalMs: 1000,
      verbose,
    });
    this.telegramBot = telegramBot;
    this.log = log;
  }

  protected async sendText(chatId: string, text: string): Promise<void> {
    const id = parseInt(chatId, 10);
    if (!isNaN(id)) await this.telegramBot.bot.api.sendMessage(id, text);
  }

  protected async sendBlock(chatId: string, _kind: BlockKind, content: string): Promise<number | null> {
    const id = parseInt(chatId, 10);
    if (isNaN(id)) return null;
    try {
      const msg = await this.telegramBot.bot.api.sendMessage(id, content);
      return msg.message_id;
    } catch (e) {
      this.log("error", `sendBlock failed: ${e}`);
      return null;
    }
  }

  protected async editBlock(
    chatId: string,
    ref: number,
    _kind: BlockKind,
    content: string,
    _sealed: boolean,
  ): Promise<void> {
    const id = parseInt(chatId, 10);
    if (isNaN(id)) return;
    try {
      await this.telegramBot.bot.api.editMessageText(id, ref, content);
    } catch (e) {
      this.log("error", `editBlock failed: ${e}`);
    }
  }
}
