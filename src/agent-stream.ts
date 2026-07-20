/**
 * Telegram stream renderer — extends BlockRenderer with Telegram-specific transport.
 * TRef = TelegramBlockRef (one or more Telegram message IDs).
 */

import {
  BlockRenderer,
  type BlockKind,
  type ChannelTarget,
  type RequestPermissionRequest,
  type VerboseConfig,
} from "@vibearound/plugin-channel-sdk";
import type { TelegramBot } from "./bot.js";

const TELEGRAM_MESSAGE_LIMIT = 4096;

interface TelegramBlockRef {
  messages: Array<{
    messageId: number;
    content: string;
  }>;
}

export class AgentStreamHandler extends BlockRenderer<TelegramBlockRef> {
  private telegramBot: TelegramBot;

  constructor(telegramBot: TelegramBot, verbose?: Partial<VerboseConfig>) {
    super({
      streaming: true,
      flushIntervalMs: 500,
      minEditIntervalMs: 1000,
      verbose,
    });
    this.telegramBot = telegramBot;
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
      for (const part of splitTelegramText(text)) {
        await this.telegramBot.bot.api.sendMessage(
          id,
          part,
          telegramDeliveryOptions(target),
        );
      }
    }
  }

  protected async sendBlock(
    target: ChannelTarget,
    _kind: BlockKind,
    content: string,
  ): Promise<TelegramBlockRef | null> {
    const id = parseInt(target.chatId, 10);
    if (isNaN(id)) return null;
    const messages: TelegramBlockRef["messages"] = [];
    for (const part of splitTelegramText(content)) {
      const msg = await this.telegramBot.bot.api.sendMessage(
        id,
        part,
        telegramDeliveryOptions(target),
      );
      messages.push({ messageId: msg.message_id, content: part });
    }
    return { messages };
  }

  protected async editBlock(
    target: ChannelTarget,
    ref: TelegramBlockRef,
    _kind: BlockKind,
    content: string,
    _sealed: boolean,
  ): Promise<void> {
    const id = parseInt(target.chatId, 10);
    if (isNaN(id)) return;
    const parts = splitTelegramText(content);
    for (let index = 0; index < parts.length; index += 1) {
      const existing = ref.messages[index];
      if (existing != null) {
        if (existing.content === parts[index]) continue;
        await this.telegramBot.bot.api.editMessageText(
          id,
          existing.messageId,
          parts[index],
        );
        existing.content = parts[index];
        continue;
      }
      const msg = await this.telegramBot.bot.api.sendMessage(
        id,
        parts[index],
        telegramDeliveryOptions(target),
      );
      ref.messages.push({ messageId: msg.message_id, content: parts[index] });
    }
  }
}

function splitTelegramText(text: string): string[] {
  const characters = Array.from(text);
  if (characters.length <= TELEGRAM_MESSAGE_LIMIT) return [text];

  const parts: string[] = [];
  for (
    let index = 0;
    index < characters.length;
    index += TELEGRAM_MESSAGE_LIMIT
  ) {
    parts.push(characters.slice(index, index + TELEGRAM_MESSAGE_LIMIT).join(""));
  }
  return parts;
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
