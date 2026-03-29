/**
 * Download and cache media from Telegram messages.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Api } from "grammy";

function log(level: string, msg: string): void {
  process.stderr.write(`[telegram-media][${level}] ${msg}\n`);
}

export interface DownloadedMedia {
  type: "image" | "file" | "video" | "voice" | "audio" | "sticker";
  path: string;
  mimeType: string;
  fileName?: string;
}

function buildCachePath(params: {
  cacheDir: string;
  chatId: string;
  messageId: string;
  ext: string;
}): string {
  const { cacheDir, chatId, messageId, ext } = params;
  return path.join(cacheDir, "telegram", chatId, `${messageId}${ext}`);
}

async function isCached(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Download a file from Telegram Bot API and cache it.
 */
export async function downloadTelegramFile(params: {
  api: Api;
  botToken: string;
  fileId: string;
  cacheDir: string;
  chatId: string;
  messageId: string;
  ext: string;
  mimeType: string;
  type: DownloadedMedia["type"];
  fileName?: string;
}): Promise<DownloadedMedia | null> {
  const { api, botToken, fileId, cacheDir, chatId, messageId, ext, mimeType, type, fileName } = params;

  const cachePath = buildCachePath({ cacheDir, chatId, messageId, ext });

  if (await isCached(cachePath)) {
    log("debug", `cache hit: ${cachePath}`);
    return { type, path: cachePath, mimeType, fileName };
  }

  try {
    const file = await api.getFile(fileId);
    if (!file.file_path) {
      log("warn", `getFile returned no file_path for ${fileId}`);
      return null;
    }

    // Download from https://api.telegram.org/file/bot{token}/{file_path}
    // grammY provides a helper URL via file.getUrl() but we need the raw token approach
    // Actually, the Bot API object doesn't expose the token. Use the file download URL directly.
    const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    log("debug", `downloading ${type} fileId=${fileId.slice(0, 20)}... url=${url.slice(0, 80)}...`);

    const res = await fetch(url);
    if (!res.ok) {
      log("error", `download failed: ${res.status} ${res.statusText}`);
      return null;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    log("debug", `downloaded ${buf.length} bytes for ${type}`);

    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, buf);
    log("debug", `cached to ${cachePath}`);

    return { type, path: cachePath, mimeType, fileName };
  } catch (err) {
    log("error", `download failed for ${type} fileId=${fileId}: ${String(err)}`);
    return null;
  }
}
