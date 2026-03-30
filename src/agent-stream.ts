/**
 * AgentStreamHandler — receives ACP session updates from the Host and renders
 * them as separate Telegram messages, one per contiguous variant block.
 *
 * Extends BlockRenderer from @vibearound/plugin-channel-sdk which handles:
 *   - Block accumulation and kind-change detection
 *   - Debounced flushing + edit throttling (1000ms for Telegram's rate limit)
 *   - Serialized sendChain for guaranteed message order
 *   - Verbose filtering (thinking / tool blocks)
 */

import {
  BlockRenderer,
  type BlockKind,
  type VerboseConfig,
} from "@vibearound/plugin-channel-sdk";
import type { TelegramBot } from "./bot.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LogFn = (level: string, msg: string) => void;

// ---------------------------------------------------------------------------
// AgentStreamHandler
// ---------------------------------------------------------------------------

export class AgentStreamHandler extends BlockRenderer<number> {
  private telegramBot: TelegramBot;
  private log: LogFn;
  private lastSessionId: string | null = null;

  constructor(telegramBot: TelegramBot, log: LogFn, verbose?: Partial<VerboseConfig>) {
    super({
      flushIntervalMs: 500,
      minEditIntervalMs: 1000,
      verbose,
    });
    this.telegramBot = telegramBot;
    this.log = log;
  }

  // ---- BlockRenderer overrides ----

  /** Telegram uses plain text with emoji prefixes. */
  protected formatContent(kind: BlockKind, content: string, _sealed: boolean): string {
    switch (kind) {
      case "thinking": return `💭 ${content}`;
      case "tool":     return content.trim();
      case "text":     return content;
    }
  }

  /** Send new message via Telegram API. */
  protected async sendBlock(channelId: string, _kind: BlockKind, content: string): Promise<number | null> {
    const chatId = parseInt(channelId, 10);
    if (isNaN(chatId)) return null;
    try {
      const msg = await this.telegramBot.bot.api.sendMessage(chatId, content);
      return msg.message_id;
    } catch (e) {
      this.log("error", `sendBlock failed: ${e}`);
      return null;
    }
  }

  /** Edit existing message for streaming updates. */
  protected async editBlock(
    channelId: string,
    ref: number,
    _kind: BlockKind,
    content: string,
    _sealed: boolean,
  ): Promise<void> {
    const chatId = parseInt(channelId, 10);
    if (isNaN(chatId)) return;
    try {
      await this.telegramBot.bot.api.editMessageText(chatId, ref, content);
    } catch (e) {
      this.log("error", `editBlock failed: ${e}`);
    }
  }

  /** Cleanup after turn completes. */
  protected async onAfterTurnEnd(channelId: string): Promise<void> {
    this.log("debug", `turn_complete session=${channelId}`);
  }

  /** Send error message to user. */
  protected async onAfterTurnError(channelId: string, error: string): Promise<void> {
    const chatId = parseInt(channelId, 10);
    if (!isNaN(chatId)) {
      this.telegramBot.bot.api.sendMessage(chatId, `❌ Error: ${error}`).catch(() => {});
    }
  }

  // ---- Prompt lifecycle ----

  /** Called before sending a prompt — resets state and tracks session. */
  onPromptSent(channelId: string): void {
    this.lastSessionId = channelId;
    super.onPromptSent(channelId);
  }

  // ---- Host ext notification handlers ----

  onAgentReady(agent: string, version: string): void {
    const chatId = this.lastSessionId ? parseInt(this.lastSessionId, 10) : null;
    if (chatId && !isNaN(chatId)) {
      this.telegramBot.bot.api.sendMessage(chatId, `🤖 Agent: ${agent} v${version}`).catch(() => {});
    }
  }

  onSessionReady(sessionId: string): void {
    const chatId = this.lastSessionId ? parseInt(this.lastSessionId, 10) : null;
    if (chatId && !isNaN(chatId)) {
      this.telegramBot.bot.api.sendMessage(chatId, `📋 Session: ${sessionId}`).catch(() => {});
    }
  }

  onSystemText(text: string): void {
    const chatId = this.lastSessionId ? parseInt(this.lastSessionId, 10) : null;
    if (chatId && !isNaN(chatId)) {
      this.telegramBot.bot.api.sendMessage(chatId, text).catch(() => {});
    }
  }
}
