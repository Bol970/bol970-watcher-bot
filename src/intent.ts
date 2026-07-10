import type { BotIntent, Env } from "./types";
import { cleanText, normalizeText } from "./utils";

export const LESSON_CATEGORIES = [
  "Графика и дизайн",
  "Видео и звук",
  "Фотография",
  "Искусство",
  "Общее развитие",
  "Программирование"
] as const;

const CATEGORY_ALIASES: Record<string, string> = {
  "графика": "Графика и дизайн",
  "дизайн": "Графика и дизайн",
  "графика и дизайн": "Графика и дизайн",
  "видео": "Видео и звук",
  "звук": "Видео и звук",
  "видео и звук": "Видео и звук",
  "фото": "Фотография",
  "фотография": "Фотография",
  "искусство": "Искусство",
  "общее развитие": "Общее развитие",
  "развитие": "Общее развитие",
  "программирован": "Программирование"
};

export async function understandIntent(env: Env, text: string): Promise<BotIntent> {
  const deterministic = parseDeterministicIntent(text);
  if (deterministic.action !== "unknown") return deterministic;
  if (!env.AI) return deterministic;

  try {
    const model = env.WORKERS_AI_MODEL || "@cf/meta/llama-3.1-8b-instruct-fast";
    const result = await env.AI.run(model, {
      messages: [
        {
          role: "system",
          content: [
            "Ты маршрутизатор Telegram-бота расписаний.",
            "Преобразуй русский запрос только в одно разрешенное действие.",
            `Категории уроков: ${LESSON_CATEGORIES.join(", ")}.`,
            "query_films означает каталог фильмов; query_new означает фактически вышедшие релизы за 7 дней.",
            "Не придумывай URL, даты или факты. Верни JSON по схеме."
          ].join(" ")
        },
        { role: "user", content: text.slice(0, 500) }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "watcher_intent",
          strict: true,
          schema: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: [
                  "query_lessons", "query_media", "query_films", "query_new", "query_history",
                  "subscribe_lessons", "subscribe_media", "unsubscribe",
                  "list_subscriptions", "status", "test", "unknown"
                ]
              },
              filterType: { type: "string", enum: ["category", "title", "genre"] },
              query: { type: "string" },
              mediaScope: { type: "string", enum: ["series", "movie", "both"] },
              onlyUpcoming: { type: "boolean" }
            },
            required: ["action", "query"],
            additionalProperties: false
          }
        }
      }
    });
    return validateAiIntent(result);
  } catch (error) {
    console.error("intent AI fallback failed", error);
    return { action: "unknown" };
  }
}

export function parseDeterministicIntent(text: string): BotIntent {
  const original = cleanText(text);
  const normalized = normalizeText(original);
  if (!normalized) return { action: "unknown" };

  if (/^(помощь|что ты умеешь)$/.test(normalized)) return { action: "help" };
  if (/^(мои подписки|подписки)$/.test(normalized)) return { action: "list_subscriptions" };
  if (/^(статус|состояние источников)$/.test(normalized)) return { action: "status" };
  if (/^(тест|проверка)$/.test(normalized)) return { action: "test" };

  if (/^(перестань|не надо|отпиши|отписаться|удали подписку)/.test(normalized)) {
    const query = stripPhrases(original, [
      /перестань\s+следить\s+за/iu,
      /не\s+надо\s+следить\s+за/iu,
      /удали\s+подписку\s+(на|по)?/iu,
      /отпиши\s+(меня\s+)?(от)?/iu,
      /отписаться\s+(от)?/iu
    ]);
    return { action: "unsubscribe", query };
  }

  if (/истори[яю]|что выходило|прошлые серии/.test(normalized)) {
    const query = stripPhrases(original, [
      /покажи\s+историю\s+(выходов\s+)?/iu,
      /история\s+(выходов\s+)?/iu,
      /что\s+выходило\s+(по\s+)?/iu,
      /прошлые\s+серии\s+/iu
    ]);
    return { action: "query_history", query };
  }

  if (/новинк/.test(normalized)) {
    const scope = /(фильм|кино|movie)/.test(normalized) && !/(сериал|сери[яи])/.test(normalized)
      ? "movie"
      : /(сериал|сери[яи])/.test(normalized) && !/(фильм|кино|movie)/.test(normalized)
        ? "series"
        : "both";
    const query = stripPhrases(original, [
      /покажи\s+новинки\s+(по\s+)?(жанр[ау]?\s+)?/iu,
      /новинки\s+(по\s+)?(жанр[ау]?\s+)?/iu,
      /какие\s+(есть\s+)?новинки\s+(по\s+)?(жанр[ау]?\s+)?/iu,
      /(фильмов|фильмы|фильм|кино|сериалов|сериалы|серии)\s*/iu,
      /(по\s+)?жанр[ау]?\s*/iu
    ]);
    return { action: "query_new", filterType: "genre", query, mediaScope: scope };
  }

  const wantsSubscribe = /^(следи|отслеживай|подпиши|хочу следить)/.test(normalized);
  if (wantsSubscribe && /(урок|эфир|трансляц)/.test(normalized)) {
    const category = findCategory(normalized);
    const query = category || stripPhrases(original, [
      /^(следи|отслеживай|подпиши\s+меня|хочу\s+следить)\s+(за\s+)?/iu,
      /(уроками|уроки|эфирами|эфиры|трансляциями|трансляции)\s+(по|про|на\s+тему)?/iu
    ]);
    return {
      action: "subscribe_lessons",
      filterType: category ? "category" : "title",
      query
    };
  }

  if (wantsSubscribe && /(фильм|кино)/.test(normalized) && /жанр/.test(normalized)) {
    const query = stripPhrases(original, [
      /^(следи|отслеживай|подпиши\s+меня|хочу\s+следить)\s+(за\s+)?/iu,
      /(новыми\s+)?(фильмами|фильмы|кино)\s*/iu,
      /(по\s+)?жанр[ау]?\s*/iu
    ]);
    return { action: "subscribe_media", filterType: "genre", query, mediaScope: "movie" };
  }

  if (wantsSubscribe && /(сериал|фильм|кино|серия)/.test(normalized)) {
    const scope = /фильм|кино/.test(normalized) && !/сериал|серия/.test(normalized) ? "movie" : "series";
    const query = stripPhrases(original, [
      /^(следи|отслеживай|подпиши\s+меня|хочу\s+следить)\s+(за\s+)?/iu,
      /(сериалом|сериал|фильмом|фильм|кино|сериями|серией)\s*/iu
    ]);
    return { action: "subscribe_media", filterType: "title", query, mediaScope: scope };
  }

  if (/когда.*(урок|эфир|трансляц)|покажи.*(урок|эфир|трансляц)|ближайш.*урок/.test(normalized)) {
    const category = findCategory(normalized);
    const query = category || stripPhrases(original, [
      /когда\s+(будет|будут|начнется|начнутся)?/iu,
      /покажи\s+(ближайшие\s+)?/iu,
      /(урок|уроки|эфир|эфиры|трансляция|трансляции)\s+(по|про|на\s+тему)?/iu
    ]);
    return { action: "query_lessons", filterType: category ? "category" : "title", query };
  }

  if (/когда.*(выйдет|выходит|серия|сериал|фильм)|следующая серия|расписание.*(сериал|фильм)/.test(normalized)) {
    const query = stripPhrases(original, [
      /когда\s+(выйдет|выходит|будет)?\s*(следующая\s+)?/iu,
      /(серия|сериал|фильм)\s*/iu,
      /расписание\s+(сериала|фильма)?/iu
    ]);
    return { action: "query_media", filterType: "title", query, mediaScope: "both" };
  }

  if (/(покажи|найди|какие|есть|новые|каталог).*(фильм|кино)|(фильм|кино).*(жанр|скоро|каталог)/.test(normalized)) {
    const onlyUpcoming = /скоро|еще не выш|ещё не выш|будущ/.test(normalized);
    const query = stripPhrases(original, [
      /^(покажи|найди|какие|какой|есть)\s*/iu,
      /(новые|недавно\s+добавленные|будущие)\s*/iu,
      /(фильмы|фильм|кино|каталог)\s*/iu,
      /(по\s+)?жанр[ау]?\s*/iu,
      /(которые\s+)?(скоро|еще|ещё)\s+(выйдут|не\s+вышли)?/iu
    ]);
    return { action: "query_films", filterType: query ? "genre" : undefined, query, mediaScope: "movie", onlyUpcoming };
  }

  return { action: "unknown" };
}

function findCategory(normalized: string): string | null {
  for (const [alias, canonical] of Object.entries(CATEGORY_ALIASES)) {
    if (normalized.includes(alias)) return canonical;
  }
  return null;
}

function stripPhrases(value: string, patterns: RegExp[]): string {
  let result = value;
  for (const pattern of patterns) result = result.replace(pattern, " ");
  return cleanText(result.replace(/^[,:;.!?\-\s]+|[,:;.!?\-\s]+$/g, ""));
}

function validateAiIntent(result: unknown): BotIntent {
  const container = result as { response?: unknown };
  let value = container?.response ?? result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { action: "unknown" };
    }
  }
  if (!value || typeof value !== "object") return { action: "unknown" };
  const candidate = value as Record<string, unknown>;
  const allowed = new Set([
    "query_lessons", "query_media", "query_films", "query_new", "query_history",
    "subscribe_lessons", "subscribe_media", "unsubscribe",
    "list_subscriptions", "status", "test", "unknown"
  ]);
  if (!allowed.has(String(candidate.action))) return { action: "unknown" };
  return {
    action: candidate.action as BotIntent["action"],
    query: cleanText(String(candidate.query || "")),
    filterType: ["category", "title", "genre"].includes(String(candidate.filterType))
      ? candidate.filterType as BotIntent["filterType"]
      : undefined,
    mediaScope: ["series", "movie", "both"].includes(String(candidate.mediaScope))
      ? candidate.mediaScope as BotIntent["mediaScope"]
      : "both",
    onlyUpcoming: candidate.onlyUpcoming === true
  };
}
