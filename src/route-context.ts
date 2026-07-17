import type {
  ChannelInboundContext,
  ConversationScope,
} from "@vibearound/plugin-channel-sdk";

export interface TelegramCallbackRoute {
  channelInstanceId: string;
  actorId: string;
  chatId: string;
  topicId?: string;
  senderId?: string;
  platformMessageId?: string;
  scope: ConversationScope;
}

/** Build the extended route attached to Telegram callback notifications. */
export function createTelegramCallbackContext(
  route: TelegramCallbackRoute,
): ChannelInboundContext {
  return {
    ...route,
    addressedBy: "callback",
  };
}
