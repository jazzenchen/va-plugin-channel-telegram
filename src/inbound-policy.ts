export interface TelegramInboundEntity {
  type: string;
  text: string;
  user?: { id: number };
}

function sameUsername(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return left.toLowerCase() === right.toLowerCase();
}

export function shouldHandleTelegramInbound(params: {
  chatType: string;
  botId: number;
  botUsername?: string;
  entities: TelegramInboundEntity[];
}): boolean {
  if (params.chatType === "private") return true;

  return params.entities.some((entity) => {
    if (entity.type === "text_mention") {
      return entity.user?.id === params.botId;
    }
    if (entity.type === "mention") {
      return sameUsername(entity.text.slice(1), params.botUsername);
    }
    if (entity.type === "bot_command") {
      const target = entity.text.split("@", 2)[1];
      return target === undefined || sameUsername(target, params.botUsername);
    }
    return false;
  });
}

export function normalizeTelegramPromptText(text: string, botUsername?: string): string {
  if (!botUsername) return text.trim();
  const escaped = botUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text
    .replace(new RegExp(`^(/[^@\\s]+)@${escaped}(?=\\s|$)`, "i"), "$1")
    .replace(new RegExp(`@${escaped}\\b`, "gi"), "")
    .trim();
}
