/**
 * TelegramBot — grammY bot wrapper.
 *
 * Handles:
 *   - Bot creation and long-polling lifecycle
 *   - Inbound message parsing → ACP prompt() to Host
 *   - Callback query handling → ACP extNotification to Host
 */

import path from "node:path";
import { Bot, type Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import {
  cancelChannelPrompt,
  channelTargetFromInboundContext,
  extractErrorMessage,
  isChannelStopCommand,
  sendChannelPrompt,
} from "@vibearound/plugin-channel-sdk";
import type { Agent, ChannelInboundContext, ContentBlock } from "@vibearound/plugin-channel-sdk";
import type { AgentStreamHandler } from "./agent-stream.js";
import { downloadTelegramFile, type DownloadedMedia } from "./media-download.js";
import { normalizeTelegramPromptText, shouldHandleTelegramInbound } from "./inbound-policy.js";
import { createTelegramCallbackContext } from "./route-context.js";

export interface TelegramConfig {
  bot_token: string;
}

export type BotContext = Context;
type LogFn = (level: string, msg: string) => void;

export class TelegramBot {
  readonly bot: Bot<BotContext>;
  private agent: Agent;
  private log: LogFn;
  private botToken: string;
  private cacheDir: string;
  private channelInstanceId: string;
  private actorId: string;
  private streamHandler: AgentStreamHandler | null = null;

  constructor(
    config: TelegramConfig,
    agent: Agent,
    log: LogFn,
    cacheDir: string,
    channelInstanceId: string,
    actorId: string,
  ) {
    this.agent = agent;
    this.log = log;
    this.botToken = config.bot_token;
    this.cacheDir = cacheDir;
    this.channelInstanceId = channelInstanceId;
    this.actorId = actorId;
    this.bot = new Bot<BotContext>(config.bot_token);

    // Install auto-retry (handles rate limits)
    this.bot.api.config.use(autoRetry());

    this.registerHandlers();
  }

  /** Probe bot identity (getMe). */
  async probe(): Promise<{ id: number; username: string; firstName: string }> {
    const me = await this.bot.api.getMe();
    return { id: me.id, username: me.username, firstName: me.first_name };
  }

  /** Start long-polling. */
  start(): Promise<void> {
    return this.bot.start({
      onStart: () => {
        this.log("info", "bot started (long polling)");
      },
    });
  }

  /** Stop the bot gracefully. */
  stop(): Promise<void> {
    return this.bot.stop();
  }

  isPolling(): boolean {
    return this.bot.isRunning();
  }

  setStreamHandler(handler: AgentStreamHandler): void {
    this.streamHandler = handler;
  }

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  private registerHandlers(): void {
    this.bot.on("message:photo", (ctx) => this.handleMediaMessage(ctx));
    this.bot.on("message:document", (ctx) => this.handleMediaMessage(ctx));
    this.bot.on("message:video", (ctx) => this.handleMediaMessage(ctx));
    this.bot.on("message:voice", (ctx) => this.handleMediaMessage(ctx));
    this.bot.on("message:audio", (ctx) => this.handleMediaMessage(ctx));
    this.bot.on("message:sticker", (ctx) => this.handleMediaMessage(ctx));

    this.bot.on("message:text", (ctx) => this.handleTextMessage(ctx));

    this.bot.on("callback_query:data", (ctx) => {
      this.handleCallbackQuery(ctx);
    });

    this.bot.catch((err) => {
      this.log("error", `bot error: ${err.message}`);
    });
  }

  private async handleTextMessage(ctx: Context): Promise<void> {
    const msg = ctx.message;
    if (!msg || !msg.text) return;

    const chat = msg.chat;
    const from = msg.from;
    if (!from) return;

    const entities = ctx.entities(["mention", "text_mention", "bot_command"]);
    if (!shouldHandleTelegramInbound({
      chatType: chat.type,
      botId: ctx.me.id,
      botUsername: ctx.me.username,
      entities,
    })) {
      this.log("debug", `group message ignored without bot mention chat=${chat.id}`);
      return;
    }

    const text = normalizeTelegramPromptText(msg.text, ctx.me.username);
    if (!text) return;

    // Use chat_id as ACP sessionId
    const chatId = String(chat.id);
    const inboundContext = {
      channelInstanceId: this.channelInstanceId,
      actorId: this.actorId,
      chatId,
      topicId: msg.message_thread_id == null ? undefined : String(msg.message_thread_id),
      senderId: String(from.id),
      platformMessageId: String(msg.message_id),
      scope: chat.type === "private" ? "dm" : "group",
      addressedBy: chat.type === "private" ? "dm" : "mention",
    } satisfies ChannelInboundContext;
    const target = channelTargetFromInboundContext(inboundContext);

    this.log("debug", `message chat=${chatId} text=${text.slice(0, 80)}`);

    if (isChannelStopCommand(text)) {
      await cancelChannelPrompt(this.agent, { context: inboundContext });
      return;
    }

    // If a permission prompt is awaiting a text reply, consume this message.
    if (this.streamHandler?.consumePendingText(target, text)) {
      return;
    }

    // Notify stream handler before prompt
    this.streamHandler?.onPromptSent(target);

    // Show typing indicator — resend every 4s (Telegram expires it after ~5s)
    await this.bot.api.sendChatAction(chat.id, "typing").catch(() => {});
    const typingInterval = setInterval(() => {
      this.bot.api.sendChatAction(chat.id, "typing").catch(() => {});
    }, 4000);

    // Send as ACP prompt — blocks until turn completes, returns real StopReason.
    // Session notifications stream in during the call.
    try {
      const response = await sendChannelPrompt(this.agent, {
        context: inboundContext,
        prompt: [{ type: "text", text }],
      });
      if (!response) {
        await this.streamHandler?.onTurnEnd(target);
        return;
      }
      this.log("info", `prompt done chat=${chatId} stopReason=${response.stopReason}`);
      await this.streamHandler?.onTurnEnd(target);
    } catch (error: unknown) {
      const msg = extractErrorMessage(error);
      this.log("error", `prompt failed chat=${chatId}: ${msg}`);
      await this.streamHandler?.onTurnError(target, msg);
    } finally {
      clearInterval(typingInterval);
    }
  }

  private async handleMediaMessage(ctx: Context): Promise<void> {
    const msg = ctx.message;
    if (!msg) return;

    const chat = msg.chat;
    const from = msg.from;
    if (!from) return;

    const entities = ctx.entities(["mention", "text_mention", "bot_command"]);
    if (!shouldHandleTelegramInbound({
      chatType: chat.type,
      botId: ctx.me.id,
      botUsername: ctx.me.username,
      entities,
    })) {
      this.log("debug", `group media ignored without bot mention chat=${chat.id}`);
      return;
    }

    const chatId = String(chat.id);
    const messageId = String(msg.message_id);
    const caption = normalizeTelegramPromptText(msg.caption ?? "", ctx.me.username);
    const inboundContext = {
      channelInstanceId: this.channelInstanceId,
      actorId: this.actorId,
      chatId,
      topicId: msg.message_thread_id == null ? undefined : String(msg.message_thread_id),
      senderId: String(from.id),
      platformMessageId: messageId,
      scope: chat.type === "private" ? "dm" : "group",
      addressedBy: chat.type === "private" ? "dm" : "mention",
    } satisfies ChannelInboundContext;
    const target = channelTargetFromInboundContext(inboundContext);
    if (caption && isChannelStopCommand(caption)) {
      await cancelChannelPrompt(this.agent, { context: inboundContext });
      return;
    }

    // Determine file info based on message type
    let fileId: string | undefined;
    let fileName: string | undefined;
    let mimeType: string;
    let ext: string;
    let mediaType: DownloadedMedia["type"];

    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      fileId = largest.file_id;
      mimeType = "image/jpeg";
      ext = ".jpg";
      mediaType = "image";
    } else if (msg.document) {
      fileId = msg.document.file_id;
      fileName = msg.document.file_name ?? undefined;
      mimeType = msg.document.mime_type ?? "application/octet-stream";
      ext = fileName && fileName.includes(".") ? `.${fileName.split(".").pop()}` : ".bin";
      mediaType = "file";
    } else if (msg.video) {
      fileId = msg.video.file_id;
      fileName = msg.video.file_name ?? undefined;
      mimeType = msg.video.mime_type ?? "video/mp4";
      ext = ".mp4";
      mediaType = "video";
    } else if (msg.voice) {
      fileId = msg.voice.file_id;
      mimeType = msg.voice.mime_type ?? "audio/ogg";
      ext = ".ogg";
      mediaType = "voice";
    } else if (msg.audio) {
      fileId = msg.audio.file_id;
      fileName = msg.audio.file_name ?? undefined;
      mimeType = msg.audio.mime_type ?? "audio/mpeg";
      ext = fileName && fileName.includes(".") ? `.${fileName.split(".").pop()}` : ".mp3";
      mediaType = "audio";
    } else if (msg.sticker) {
      fileId = msg.sticker.file_id;
      mimeType = msg.sticker.is_animated ? "application/x-tgsticker" : "image/webp";
      ext = msg.sticker.is_animated ? ".tgs" : ".webp";
      mediaType = "sticker";
    } else {
      return;
    }

    if (!fileId) return;

    this.log("debug", `media message chat=${chatId} type=${mediaType} caption=${caption.slice(0, 80)}`);

    // Download and cache the file
    const media = await downloadTelegramFile({
      api: this.bot.api,
      botToken: this.botToken,
      fileId,
      cacheDir: this.cacheDir,
      chatId,
      messageId,
      ext,
      mimeType,
      type: mediaType,
      fileName,
    });

    // Build content blocks
    const contentBlocks: ContentBlock[] = [];

    if (caption) {
      contentBlocks.push({ type: "text", text: caption });
    } else {
      contentBlocks.push({ type: "text", text: `The user sent ${mediaType === "image" ? "an image" : `a ${mediaType}`}.` });
    }

    if (media) {
      contentBlocks.push({
        type: "resource_link",
        uri: `file://${media.path}`,
        name: media.fileName ?? path.basename(media.path),
        mimeType: media.mimeType,
      });
    }

    // Notify stream handler before prompt
    this.streamHandler?.onPromptSent(target);

    // Typing indicator
    await this.bot.api.sendChatAction(chat.id, "typing").catch(() => {});
    const typingInterval = setInterval(() => {
      this.bot.api.sendChatAction(chat.id, "typing").catch(() => {});
    }, 4000);

    try {
      const response = await sendChannelPrompt(this.agent, {
        context: inboundContext,
        prompt: contentBlocks,
      });
      if (!response) {
        await this.streamHandler?.onTurnEnd(target);
        return;
      }
      this.log("info", `prompt done chat=${chatId} stopReason=${response.stopReason}`);
      await this.streamHandler?.onTurnEnd(target);
    } catch (error: unknown) {
      const msg = extractErrorMessage(error);
      this.log("error", `prompt failed chat=${chatId}: ${msg}`);
      await this.streamHandler?.onTurnError(target, msg);
    } finally {
      clearInterval(typingInterval);
    }
  }

  private handleCallbackQuery(ctx: Context): void {
    const query = ctx.callbackQuery;
    if (!query || !query.data) return;

    const from = query.from;
    const chatId = query.message?.chat?.id;
    if (!chatId) return;

    // Permission button — format: va_perm:<callbackId>:<optionId>
    if (query.data.startsWith("va_perm:")) {
      const rest = query.data.slice("va_perm:".length);
      const colon = rest.indexOf(":");
      if (colon > 0) {
        const callbackId = rest.slice(0, colon);
        const optionId = rest.slice(colon + 1);

        // Look up the button label from the original keyboard before we wipe it.
        const keyboard = query.message?.reply_markup?.inline_keyboard ?? [];
        let optionName = optionId;
        for (const row of keyboard) {
          for (const btn of row) {
            if ("callback_data" in btn && btn.callback_data === query.data) {
              optionName = btn.text;
            }
          }
        }

        const ok =
          this.streamHandler?.resolvePermission(callbackId, optionId) ?? false;
        this.log(
          "info",
          `permission resolve cb=${callbackId} option=${optionId} ok=${ok}`,
        );

        // Replace the message: remove buttons + show selected label.
        const chatIdNum = query.message?.chat?.id;
        const messageId = query.message?.message_id;
        if (chatIdNum != null && messageId != null) {
          const finalText = ok
            ? `🔐 Permission — selected: ${optionName}`
            : `🔐 Permission — already handled`;
          this.bot.api
            .editMessageText(chatIdNum, messageId, finalText)
            .catch((e) =>
              this.log("error", `telegram edit permission msg failed: ${e}`),
            );
        }

        ctx
          .answerCallbackQuery({ text: ok ? `Selected: ${optionName}` : "" })
          .catch(() => {});
      } else {
        ctx.answerCallbackQuery().catch(() => {});
      }
      return;
    }

    // Generic callback — forward to host.
    const callbackContext = createTelegramCallbackContext({
      channelInstanceId: this.channelInstanceId,
      actorId: this.actorId,
      chatId: String(chatId),
      topicId:
        query.message &&
        "message_thread_id" in query.message &&
        query.message.message_thread_id != null
          ? String(query.message.message_thread_id)
          : undefined,
      senderId: String(from.id),
      platformMessageId: query.message
        ? String(query.message.message_id)
        : undefined,
      scope: query.message?.chat.type === "private" ? "dm" : "group",
    });
    this.agent
      .extNotification?.("_va/callback", {
        chatId: String(chatId),
        callbackId: query.id,
        sender: {
          id: String(from.id),
          name: [from.first_name, from.last_name].filter(Boolean).join(" "),
          username: from.username,
        },
        data: query.data,
        messageId: query.message
          ? String(query.message.message_id)
          : undefined,
        "va.channel": callbackContext,
      })
      .catch(() => {});

    ctx.answerCallbackQuery().catch(() => {});
  }
}
