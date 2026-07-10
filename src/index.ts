import { LESSON_CATEGORIES, understandIntent } from "./intent";
import { selectLessonStages } from "./lesson-view";
import { refreshAll } from "./refresh";
import {
  addSubscription,
  clearDialogSession,
  deactivateSubscriptions,
  ensureUser,
  getDialogSession,
  getSourceStates,
  listSubscriptions,
  queryLiveEvents,
  queryMediaHistory,
  queryMovieCatalog,
  queryNewByGenre,
  queryUpcomingMedia,
  resolveMediaTitle,
  saveDialogSession
} from "./storage";
import {
  answerCallbackQuery,
  inlineKeyboard,
  sendMessage,
  type TelegramCallbackQuery,
  type TelegramMessage,
  type TelegramUpdate
} from "./telegram";
import type { BotIntent, Env } from "./types";
import { addDays, cleanText, formatDate, formatMoscowDateTime, jsonResponse, safeError } from "./utils";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return healthResponse(env);
    }
    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      return telegramWebhook(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      refreshAll(env, { notify: true }).then((summary) => {
        console.log("scheduled refresh completed", summary);
      }).catch((error) => console.error("scheduled refresh failed", safeError(error)))
    );
  }
};

async function healthResponse(env: Env): Promise<Response> {
  try {
    const sources = await getSourceStates(env.DB);
    return jsonResponse({
      ok: true,
      name: env.BOT_DISPLAY_NAME || "Bol970 Watcher",
      bot: "@Bol970_watcher_bot",
      time: new Date().toISOString(),
      sources
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      name: env.BOT_DISPLAY_NAME || "Bol970 Watcher",
      error: safeError(error),
      time: new Date().toISOString()
    }, 503);
  }
}

async function telegramWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const expected = env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== expected) {
    return new Response("Forbidden", { status: 403 });
  }

  let update: TelegramUpdate;
  try {
    update = await request.json() as TelegramUpdate;
  } catch {
    return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  }

  ctx.waitUntil(processUpdate(env, update).catch(async (error) => {
    console.error("telegram update failed", safeError(error));
    const chatId = getChatId(update);
    if (chatId) await sendMessage(env, chatId, "Не получилось обработать запрос. Попробуйте ещё раз или используйте /help.").catch(() => {});
  }));
  return jsonResponse({ ok: true });
}

async function processUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  if (update.callback_query) {
    await processCallback(env, update.callback_query);
    return;
  }
  const message = update.message || update.edited_message;
  if (!message?.text || !message.from) return;
  const actor = authorize(env, String(message.from.id));
  const chatId = String(message.chat.id);
  if (!actor) {
    await sendMessage(env, chatId, `Доступ к боту ограничен. Ваш Telegram ID: ${message.from.id}`);
    return;
  }
  await ensureUser(env.DB, String(message.from.id), chatId, actor);
  await processText(env, message, actor);
}

async function processText(env: Env, message: TelegramMessage, role: "owner" | "teacher"): Promise<void> {
  const text = cleanText(message.text);
  const chatId = String(message.chat.id);
  const telegramId = String(message.from?.id || "");
  const command = parseCommand(text);
  if (command) {
    await handleCommand(env, telegramId, chatId, role, command.name, command.arg);
    return;
  }

  const session = await getDialogSession(env.DB, telegramId);
  if (session) {
    await handleSessionText(env, telegramId, chatId, session.step, text);
    return;
  }

  await executeIntent(env, telegramId, chatId, role, await understandIntent(env, text));
}

async function handleCommand(
  env: Env,
  telegramId: string,
  chatId: string,
  role: "owner" | "teacher",
  name: string,
  arg: string
): Promise<void> {
  if (name === "start" || name === "help") return sendHelp(env, chatId);
  if (name === "id" || name === "whoami") return sendMessage(env, chatId, `Ваш Telegram ID: ${telegramId}`);
  if (name === "cancel") return executeIntent(env, telegramId, chatId, role, { action: "cancel" });
  if (name === "lessons") return executeIntent(env, telegramId, chatId, role, { action: "query_lessons", query: arg });
  if (name === "schedule") return executeIntent(env, telegramId, chatId, role, { action: "query_lessons", query: arg, fullSchedule: true });
  if (name === "media") return executeIntent(env, telegramId, chatId, role, { action: "query_media", query: arg });
  if (name === "films") return executeIntent(env, telegramId, chatId, role, parseFilmsCommand(arg));
  if (name === "new") return executeIntent(env, telegramId, chatId, role, parseNewCommand(arg));
  if (name === "history") return executeIntent(env, telegramId, chatId, role, { action: "query_history", query: arg });
  if (name === "subscriptions") return executeIntent(env, telegramId, chatId, role, { action: "list_subscriptions" });
  if (name === "status") return executeIntent(env, telegramId, chatId, role, { action: "status" });
  if (name === "test") return executeIntent(env, telegramId, chatId, role, { action: "test" });
  if (name === "refresh") return executeIntent(env, telegramId, chatId, role, { action: "refresh" });

  if (name === "watch") {
    if (arg) {
      const intent = await understandIntent(env, /^следи/iu.test(arg) ? arg : `Следи за ${arg}`);
      return executeIntent(env, telegramId, chatId, role, intent);
    }
    await sendMessage(env, chatId, "Что отслеживать?", watchKeyboard());
    return;
  }

  if (name === "unwatch") {
    if (arg) return executeIntent(env, telegramId, chatId, role, { action: "unsubscribe", query: arg });
    await saveDialogSession(env.DB, telegramId, chatId, "unwatch");
    await sendMessage(env, chatId, "Напишите название подписки, которую нужно отключить. Для отмены: /cancel");
    return;
  }

  await sendMessage(env, chatId, "Не знаю такую команду. Используйте /help.");
}

async function executeIntent(
  env: Env,
  telegramId: string,
  chatId: string,
  role: "owner" | "teacher",
  intent: BotIntent
): Promise<void> {
  const query = cleanText(intent.query);
  switch (intent.action) {
    case "help":
      await sendHelp(env, chatId);
      return;
    case "query_lessons": {
      const rows = await queryLiveEvents(env.DB, query, 200);
      await sendMessage(
        env,
        chatId,
        intent.fullSchedule ? formatFullLessonSchedule(rows, query) : formatLessonTimeline(rows, query)
      );
      return;
    }
    case "query_media": {
      const rows = await queryUpcomingMedia(env.DB, query);
      await sendMessage(env, chatId, formatMedia(rows, query, false));
      return;
    }
    case "query_films": {
      const rows = await queryMovieCatalog(env.DB, query, intent.onlyUpcoming === true);
      await sendMessage(env, chatId, formatMovieCatalog(rows, query, intent.onlyUpcoming === true));
      return;
    }
    case "query_new": {
      const since = addDays(new Date(), -7).toISOString().slice(0, 10);
      const rows = await queryNewByGenre(env.DB, query, since, intent.mediaScope || "both");
      await sendMessage(env, chatId, formatMedia(rows, query, true));
      return;
    }
    case "query_history": {
      if (!query) {
        await sendMessage(env, chatId, "Укажите название, например: /history Медведь");
        return;
      }
      const rows = await queryMediaHistory(env.DB, query);
      await sendMessage(env, chatId, formatMedia(rows, query, true));
      return;
    }
    case "subscribe_lessons": {
      if (!query) {
        await saveDialogSession(env.DB, telegramId, chatId, "lesson_title");
        await sendMessage(env, chatId, "Напишите категорию или слова из названия урока.");
        return;
      }
      await addSubscription(env.DB, {
        telegramId,
        domain: "lessons",
        filterType: intent.filterType === "category" ? "category" : "title",
        filterValue: query
      });
      await sendMessage(env, chatId, `Подписка на эфиры добавлена: ${query}`);
      return;
    }
    case "subscribe_media": {
      if (!query) {
        await saveDialogSession(env.DB, telegramId, chatId, "media_title");
        await sendMessage(env, chatId, "Напишите название сериала или фильма.");
        return;
      }
      const scope = intent.mediaScope || "both";
      const filterValue = intent.filterType === "genre" ? query : await resolveMediaTitle(env.DB, query, scope);
      await addSubscription(env.DB, {
        telegramId,
        domain: "media",
        filterType: intent.filterType === "genre" ? "genre" : "title",
        filterValue,
        mediaScope: scope
      });
      await sendMessage(env, chatId, `Подписка LostFilm добавлена: ${filterValue}`);
      return;
    }
    case "unsubscribe": {
      if (!query) {
        await saveDialogSession(env.DB, telegramId, chatId, "unwatch");
        await sendMessage(env, chatId, "Напишите название подписки, которую нужно отключить.");
        return;
      }
      const count = await deactivateSubscriptions(env.DB, telegramId, query);
      await sendMessage(env, chatId, count ? `Отключено подписок: ${count}` : "Активная подписка с таким названием не найдена.");
      return;
    }
    case "list_subscriptions": {
      const rows = await listSubscriptions(env.DB, telegramId);
      if (!rows.length) {
        await sendMessage(env, chatId, "Активных подписок пока нет. Используйте /watch.");
        return;
      }
      const lines = rows.map((row, index) => {
        const domain = row.domain === "lessons" ? "эфиры" : "LostFilm";
        return `${index + 1}. ${domain}: ${row.filter_value}`;
      });
      await sendMessage(env, chatId, `Ваши подписки:\n${lines.join("\n")}`);
      return;
    }
    case "status": {
      const states = await getSourceStates(env.DB);
      if (!states.length) {
        await sendMessage(env, chatId, "Источники ещё не проверялись. Запустите /test.");
        return;
      }
      const lines = states.map((row) => [
        String(row.source),
        row.last_success_at ? `успешно: ${row.last_success_at}` : "успешных проверок нет",
        `объектов: ${row.last_item_count || 0}`,
        Number(row.consecutive_failures || 0) ? `ошибок подряд: ${row.consecutive_failures}` : "ошибок нет"
      ].join(" · "));
      await sendMessage(env, chatId, lines.join("\n"));
      return;
    }
    case "test":
    case "refresh": {
      if (intent.action === "refresh" && role !== "owner") {
        await sendMessage(env, chatId, "Команда /refresh доступна только владельцу. Для проверки используйте /test.");
        return;
      }
      await sendMessage(env, chatId, "Проверяю LiveClasses и LostFilm…").catch((error) => {
        console.warn("could not send refresh progress message", safeError(error));
      });
      const summary = await refreshAll(env, { notify: intent.action === "refresh" });
      if (summary.busy) {
        await sendMessage(env, chatId, "Проверка уже выполняется. Повторите через минуту.");
        return;
      }
      await sendMessage(env, chatId, [
        "Проверка завершена.",
        `LiveClasses: ${summary.liveCount} текущих и будущих эфиров.`,
        `LostFilm: ${summary.scheduledCount} событий в расписании, ${summary.releasedCount} новинок.`,
        `Каталог фильмов: ${summary.catalogCount}, впервые замечено: ${summary.catalogAdded}.`,
        `Обновлено карточек с жанрами: ${summary.metadataUpdated}.`,
        ...(summary.errors.length ? [`Ошибки: ${summary.errors.join("; ")}`] : ["Ошибок нет."])
      ].join("\n"));
      return;
    }
    case "cancel":
      await clearDialogSession(env.DB, telegramId);
      await sendMessage(env, chatId, "Текущий диалог отменён.");
      return;
    default:
      await sendMessage(env, chatId, "Не понял запрос. Попробуйте написать иначе или используйте /watch, /lessons, /media, /films, /new и /help.");
  }
}

async function processCallback(env: Env, callback: TelegramCallbackQuery): Promise<void> {
  const telegramId = String(callback.from.id);
  const chatId = String(callback.message?.chat.id || "");
  const role = authorize(env, telegramId);
  if (!chatId || !role) {
    await answerCallbackQuery(env, callback.id, "Нет доступа");
    return;
  }
  await ensureUser(env.DB, telegramId, chatId, role);
  const data = callback.data || "";
  if (data.startsWith("category:")) {
    const index = Number(data.split(":")[1]);
    const category = LESSON_CATEGORIES[index];
    if (category) {
      await addSubscription(env.DB, {
        telegramId,
        domain: "lessons",
        filterType: "category",
        filterValue: category
      });
      await clearDialogSession(env.DB, telegramId);
      await answerCallbackQuery(env, callback.id, "Подписка добавлена");
      await sendMessage(env, chatId, `Отслеживаю эфиры категории «${category}».`);
      return;
    }
  }
  const steps: Record<string, { step: string; prompt: string }> = {
    "dialog:lesson_category": { step: "lesson_category", prompt: "Выберите категорию:" },
    "dialog:lesson_title": { step: "lesson_title", prompt: "Напишите слова из названия урока:" },
    "dialog:media_title": { step: "media_title", prompt: "Напишите название сериала или фильма:" },
    "dialog:media_genre": { step: "media_genre", prompt: "Напишите жанр новинок:" },
    "dialog:movie_genre": { step: "movie_genre", prompt: "Напишите жанр фильмов:" }
  };
  const selected = steps[data];
  if (!selected) {
    await answerCallbackQuery(env, callback.id, "Неизвестное действие");
    return;
  }
  await saveDialogSession(env.DB, telegramId, chatId, selected.step);
  await answerCallbackQuery(env, callback.id);
  if (selected.step === "lesson_category") {
    await sendMessage(env, chatId, selected.prompt, inlineKeyboard(
      LESSON_CATEGORIES.map((category, index) => [{ text: category, data: `category:${index}` }])
    ));
  } else {
    await sendMessage(env, chatId, `${selected.prompt}\nДля отмены: /cancel`);
  }
}

async function handleSessionText(
  env: Env,
  telegramId: string,
  chatId: string,
  step: string,
  text: string
): Promise<void> {
  if (step === "lesson_title") {
    await addSubscription(env.DB, { telegramId, domain: "lessons", filterType: "title", filterValue: text });
    await clearDialogSession(env.DB, telegramId);
    await sendMessage(env, chatId, `Отслеживаю эфиры по словам «${text}».`);
    return;
  }
  if (step === "media_title") {
    await addSubscription(env.DB, { telegramId, domain: "media", filterType: "title", filterValue: text, mediaScope: "both" });
    await clearDialogSession(env.DB, telegramId);
    await sendMessage(env, chatId, `Отслеживаю LostFilm по названию «${text}».`);
    return;
  }
  if (step === "media_genre") {
    await addSubscription(env.DB, { telegramId, domain: "media", filterType: "genre", filterValue: text, mediaScope: "both" });
    await clearDialogSession(env.DB, telegramId);
    await sendMessage(env, chatId, `Отслеживаю новинки жанра «${text}».`);
    return;
  }
  if (step === "movie_genre") {
    await addSubscription(env.DB, { telegramId, domain: "media", filterType: "genre", filterValue: text, mediaScope: "movie" });
    await clearDialogSession(env.DB, telegramId);
    await sendMessage(env, chatId, `Отслеживаю новые фильмы жанра «${text}».`);
    return;
  }
  if (step === "unwatch") {
    const count = await deactivateSubscriptions(env.DB, telegramId, text);
    await clearDialogSession(env.DB, telegramId);
    await sendMessage(env, chatId, count ? `Отключено подписок: ${count}` : "Подписка не найдена.");
    return;
  }
  await clearDialogSession(env.DB, telegramId);
  await sendMessage(env, chatId, "Состояние диалога устарело. Начните заново с /watch.");
}

function sendHelp(env: Env, chatId: string): Promise<void> {
  return sendMessage(env, chatId, [
    `${env.BOT_DISPLAY_NAME || "Bol970 Watcher"} следит за эфирами LiveClasses и релизами LostFilm.`,
    "",
    "Можно писать обычными фразами:",
    "• Следи за уроками по программированию",
    "• Когда будет урок про Blender?",
    "• Следи за сериалом Медведь",
    "• Покажи новинки жанра драма",
    "• Покажи фильмы жанра фантастика",
    "• Какие фильмы скоро выйдут?",
    "",
    "Команды:",
    "/watch — создать подписку",
    "/lessons [тема] — сейчас, потом и далее",
    "/schedule [тема] — полное расписание эфиров",
    "/media [название] — будущие релизы",
    "/films [жанр или название] — каталог фильмов",
    "/new [фильмы|сериалы] [жанр] — фактические новинки за 7 дней",
    "/history название — история LostFilm",
    "/subscriptions — подписки",
    "/unwatch название — отключить",
    "/test — немедленно проверить источники",
    "/status — состояние источников",
    "/cancel — отменить диалог"
  ].join("\n"));
}

function watchKeyboard() {
  return inlineKeyboard([
    [{ text: "Эфиры по категории", data: "dialog:lesson_category" }],
    [{ text: "Эфиры по названию", data: "dialog:lesson_title" }],
    [{ text: "Сериал или фильм", data: "dialog:media_title" }],
    [{ text: "Новинки по жанру", data: "dialog:media_genre" }],
    [{ text: "Новые фильмы по жанру", data: "dialog:movie_genre" }]
  ]);
}

function formatLessonTimeline(rows: Record<string, unknown>[], query: string): string {
  if (!rows.length) return query
    ? `В расписании на сегодня и завтра ничего не найдено по запросу «${query}».`
    : "В расписании на сегодня и завтра нет текущих или будущих эфиров.";
  const stages = selectLessonStages(rows);
  const hasLive = stages[0]?.kind === "live";
  const blocks = stages.map((stage, index) => {
    let heading: string;
    if (stage.kind === "live") {
      heading = "🔴 Сейчас в эфире";
    } else {
      const futureIndex = hasLive ? index - 1 : index;
      const label = hasLive
        ? futureIndex === 0 ? "Потом" : "Далее"
        : futureIndex === 0 ? "Ближайший эфир" : futureIndex === 1 ? "Потом" : "Далее";
      heading = `${label} — ${formatMoscowDateTime(stage.scheduledAt || "")}`;
    }
    return [heading, ...stage.rows.map(formatLessonRow)].join("\n\n");
  });
  return `Три ближайших этапа${query ? ` по запросу «${query}»` : ""}:\n\n${blocks.join("\n\n")}`;
}

function formatFullLessonSchedule(rows: Record<string, unknown>[], query: string): string {
  if (!rows.length) return query
    ? `В полном расписании ничего не найдено по запросу «${query}».`
    : "В полном расписании нет текущих или будущих эфиров.";
  const lines = rows.map((row) => [
    `• ${row.title}`,
    `${row.category}${row.author ? ` · ${row.author}` : ""}`,
    row.status === "live" ? "Сейчас в эфире" : formatMoscowDateTime(String(row.scheduled_at || "")),
    row.status === "live" ? `Смотреть трансляцию: ${row.url}` : row.url
  ].join("\n"));
  return `Полное расписание эфиров${query ? ` по запросу «${query}»` : ""}:\n\n${lines.join("\n\n")}`;
}

function formatLessonRow(row: Record<string, unknown>): string {
  return [
    `• ${row.title}`,
    `${row.category}${row.author ? ` · ${row.author}` : ""}`,
    row.status === "live" ? `Смотреть трансляцию: ${row.url}` : row.url
  ].join("\n");
}

function formatMedia(rows: Record<string, unknown>[], query: string, historical: boolean): string {
  if (!rows.length) return query
    ? `LostFilm: ничего не найдено по запросу «${query}».`
    : "LostFilm: подходящих записей пока нет.";
  const lines = rows.map((row) => {
    const season = row.season ? ` ${row.season}x${String(row.episode || "").padStart(2, "0")}` : "";
    const date = String(row.released_date || row.scheduled_date || "");
    return `• ${row.title_ru}${season} — ${formatDate(date || null)}\n${row.url}`;
  });
  const label = historical ? "Результаты LostFilm" : "Ближайшие релизы";
  return `${label}${query ? ` по запросу «${query}»` : ""}:\n\n${lines.join("\n\n")}`;
}

function formatMovieCatalog(rows: Record<string, unknown>[], query: string, onlyUpcoming: boolean): string {
  if (!rows.length) return query
    ? `В каталоге фильмов ничего не найдено по запросу «${query}».`
    : onlyUpcoming
      ? "В каталоге пока нет отмеченных будущих фильмов."
      : "Каталог фильмов пока не загружен. Запустите /test.";
  const lines = rows.map((row) => {
    let genres: string[] = [];
    try {
      genres = JSON.parse(String(row.genres_json || "[]")) as string[];
    } catch {
      genres = [];
    }
    const details = [
      Number(row.not_aired) ? "Скоро" : "В каталоге",
      row.release_year ? String(row.release_year) : "",
      Number(row.rating) > 0 ? `рейтинг ${row.rating}` : "",
      genres.join(", ")
    ].filter(Boolean).join(" · ");
    return `• ${row.title_ru}${row.title_en ? ` / ${row.title_en}` : ""}\n${details}\n${row.url}`;
  });
  const label = onlyUpcoming ? "Будущие фильмы" : "Каталог фильмов";
  return `${label}${query ? ` по запросу «${query}»` : ""}:\n\n${lines.join("\n\n")}`;
}

function authorize(env: Env, telegramId: string): "owner" | "teacher" | null {
  if (telegramId && telegramId === String(env.OWNER_TELEGRAM_ID || "")) return "owner";
  if (telegramId && telegramId === String(env.TEACHER_TELEGRAM_ID || "")) return "teacher";
  return null;
}

function parseCommand(text: string): { name: string; arg: string } | null {
  const match = text.match(/^\/([a-z_]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]+))?$/i);
  return match ? { name: match[1]!.toLowerCase(), arg: cleanText(match[2]) } : null;
}

function parseNewCommand(arg: string): BotIntent {
  const hasMovies = /(?:^|\s)(фильмы?|кино|movies?)(?=\s|$)/iu.test(arg);
  const hasSeries = /(?:^|\s)(сериалы?|серии|series)(?=\s|$)/iu.test(arg);
  const query = cleanText(arg.replace(/(?:^|\s)(фильмы?|кино|movies?|сериалы?|серии|series)(?=\s|$)/giu, " "));
  return {
    action: "query_new",
    query,
    filterType: "genre",
    mediaScope: hasMovies && !hasSeries ? "movie" : hasSeries && !hasMovies ? "series" : "both"
  };
}

function parseFilmsCommand(arg: string): BotIntent {
  const onlyUpcoming = /^(скоро|будущие|еще не вышли|ещё не вышли)$/iu.test(cleanText(arg));
  return {
    action: "query_films",
    query: onlyUpcoming ? "" : arg,
    filterType: arg && !onlyUpcoming ? "genre" : undefined,
    mediaScope: "movie",
    onlyUpcoming
  };
}

function getChatId(update: TelegramUpdate): string {
  return String(
    update.message?.chat.id ||
    update.edited_message?.chat.id ||
    update.callback_query?.message?.chat.id ||
    ""
  );
}
