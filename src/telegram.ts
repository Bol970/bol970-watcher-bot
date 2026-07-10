import type { Env } from "./types";
import { splitTelegramText } from "./utils";

export interface TelegramUser {
  id: number;
  first_name?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface ReplyMarkup {
  inline_keyboard: { text: string; callback_data: string }[][];
}

export async function sendMessage(
  env: Env,
  chatId: string,
  text: string,
  replyMarkup?: ReplyMarkup
): Promise<void> {
  for (const part of splitTelegramText(text)) {
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: part,
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });
  }
}

export async function answerCallbackQuery(env: Env, callbackQueryId: string, text?: string): Promise<void> {
  await telegramApi(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {})
  });
}

export function inlineKeyboard(rows: { text: string; data: string }[][]): ReplyMarkup {
  return {
    inline_keyboard: rows.map((row) => row.map((item) => ({
      text: item.text,
      callback_data: item.data
    })))
  };
}

export async function telegramApi(
  env: Env,
  method: string,
  payload: Record<string, unknown>
): Promise<unknown> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json() as { ok?: boolean; result?: unknown; description?: string };
  if (!response.ok || data.ok === false) {
    throw new Error(`Telegram API ${method} failed: ${response.status} ${data.description || "unknown error"}`);
  }
  return data.result;
}
