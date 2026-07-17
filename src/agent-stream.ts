/**
 * Telegram stream renderer — extends BlockRenderer with Telegram-specific transport.
 * TRef = number (Telegram message ID).
 */

import {
  BlockRenderer,
  type BlockKind,
  type ChannelTarget,
  type RequestPermissionRequest,
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

  /** Render permission request as inline keyboard. */
  protected async onRequestPermission(
    target: ChannelTarget,
    request: RequestPermissionRequest,
    callbackId: string,
  ): Promise<void> {
    const id = parseInt(target.chatId, 10);
    if (isNaN(id)) return;
    const options = request.options ?? [];
    const toolTitle =
      (request.toolCall as { title?: string } | undefined)?.title ?? "the agent";

    // Single row with all buttons side-by-side. Telegram auto-wraps if the
    // row is too wide, so 3-4 short labels fit fine; longer labels may spill
    // to extra rows automatically on the client.
    const keyboard = [
      options.map((opt) => ({
        text: opt.name,
        // Telegram callback data is capped at 64 bytes. callbackId is ~12
        // chars, optionId is typically short ("allow_once" etc).
        callback_data: `va_perm:${callbackId}:${opt.optionId}`.slice(0, 64),
      })),
    ];

    await this.telegramBot.bot.api.sendMessage(
      id,
      `🔐 Permission required — ${toolTitle}`,
      {
        ...telegramDeliveryOptions(target),
        reply_markup: { inline_keyboard: keyboard },
      },
    );
  }

  protected async sendText(target: ChannelTarget, text: string): Promise<void> {
    const id = parseInt(target.chatId, 10);
    if (!isNaN(id)) {
      await this.telegramBot.bot.api.sendMessage(
        id,
        text,
        telegramDeliveryOptions(target),
      );
    }
  }

  protected async sendBlock(target: ChannelTarget, _kind: BlockKind, content: string): Promise<number | null> {
    const id = parseInt(target.chatId, 10);
    if (isNaN(id)) return null;
    try {
      const msg = await this.telegramBot.bot.api.sendMessage(
        id,
        content,
        telegramDeliveryOptions(target),
      );
      return msg.message_id;
    } catch (e) {
      this.log("error", `sendBlock failed: ${e}`);
      return null;
    }
  }

  protected async editBlock(
    target: ChannelTarget,
    ref: number,
    _kind: BlockKind,
    content: string,
    _sealed: boolean,
  ): Promise<void> {
    const id = parseInt(target.chatId, 10);
    if (isNaN(id)) return;
    try {
      await this.telegramBot.bot.api.editMessageText(id, ref, content);
    } catch (e) {
      this.log("error", `editBlock failed: ${e}`);
    }
  }
}

function telegramDeliveryOptions(target: ChannelTarget): {
  message_thread_id?: number;
  reply_parameters?: { message_id: number };
} {
  const topicId = parseTelegramMessageId(target.topicId);
  const replyTo = parseTelegramMessageId(target.replyTo);
  return {
    ...(topicId == null ? {} : { message_thread_id: topicId }),
    ...(replyTo == null ? {} : { reply_parameters: { message_id: replyTo } }),
  };
}

function parseTelegramMessageId(value: string | undefined): number | undefined {
  if (value == null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
