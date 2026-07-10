import { parseLiveClasses } from "./parsers/liveclasses";
import {
  detailsUrlForEvent,
  parseLostFilmMetadata,
  parseLostFilmMoviesCatalog,
  parseLostFilmNew,
  parseLostFilmSchedule
} from "./parsers/lostfilm";
import {
  acquireRefreshLock,
  deleteNotificationReservation,
  getActiveSubscriptions,
  getGenresForMedia,
  getMetadataDue,
  isSourceInitialized,
  markPastLostFilmDates,
  recordSourceFailure,
  recordSourceSuccess,
  releaseRefreshLock,
  reserveNotification,
  saveMediaMetadata,
  syncLiveEvents,
  upsertLostFilmReleases,
  upsertLostFilmMovieCatalog,
  upsertLostFilmSchedule,
  type LiveChange,
  type MediaChange,
  type MovieCatalogChange,
  type SubscriptionRow
} from "./storage";
import { sendMessage } from "./telegram";
import type { Env, LiveEvent, LostFilmEvent, LostFilmMovieCatalogItem, RefreshSummary } from "./types";
import {
  addDays,
  formatDate,
  formatMoscowDateTime,
  moscowDateParts,
  looseNormalize,
  normalizeText,
  safeError,
  toIsoDate
} from "./utils";

const LIVECLASSES_URL = "https://liveclasses.ru/schedule/";
const LOSTFILM_URL = "https://www.lostfilm.download/schedule/";
const LOSTFILM_NEW_URL = "https://www.lostfilm.download/new/";
const LOSTFILM_MOVIES_URL = "https://www.lostfilm.download/movies/";
const LOSTFILM_AJAX_URL = "https://www.lostfilm.download/ajaxik.php";
const USER_AGENT = "Bol970WatcherBot/1.0 (+https://github.com/Bol970/bol970-watcher-bot)";

export async function refreshAll(env: Env, options: { notify?: boolean } = {}): Promise<RefreshSummary> {
  const summary: RefreshSummary = {
    liveCount: 0,
    scheduledCount: 0,
    releasedCount: 0,
    catalogCount: 0,
    catalogAdded: 0,
    metadataUpdated: 0,
    errors: []
  };

  if (!(await acquireRefreshLock(env.DB))) return { ...summary, busy: true };
  try {
    const liveResult = await refreshLiveClasses(env, options.notify !== false).catch((error) => {
      summary.errors.push(`LiveClasses: ${safeError(error)}`);
      return { count: 0 };
    });
    summary.liveCount = liveResult.count;

    const [lostResult, catalogResult] = await Promise.all([
      refreshLostFilm(env, options.notify !== false).catch((error) => {
        summary.errors.push(`LostFilm: ${safeError(error)}`);
        return { scheduled: 0, released: 0, metadata: 0 };
      }),
      refreshLostFilmMovieCatalog(env, options.notify !== false).catch((error) => {
        summary.errors.push(`LostFilm movies: ${safeError(error)}`);
        return { count: 0, added: 0 };
      })
    ]);
    summary.scheduledCount = lostResult.scheduled;
    summary.releasedCount = lostResult.released;
    summary.catalogCount = catalogResult.count;
    summary.catalogAdded = catalogResult.added;
    summary.metadataUpdated = lostResult.metadata;
    return summary;
  } finally {
    await releaseRefreshLock(env.DB).catch((error) => console.error("failed to release refresh lock", error));
  }
}

async function refreshLiveClasses(env: Env, notify: boolean): Promise<{ count: number }> {
  try {
    const html = await fetchText(LIVECLASSES_URL);
    const events = parseLiveClasses(html, new Date());
    const changes = await syncLiveEvents(env.DB, events);
    await recordSourceSuccess(env.DB, "liveclasses", LIVECLASSES_URL, events.length);
    if (notify) {
      await notifyLiveChanges(env, changes);
      await notifyUpcomingLessons(env, events);
    }
    return { count: events.length };
  } catch (error) {
    const message = safeError(error);
    const failures = await recordSourceFailure(env.DB, "liveclasses", LIVECLASSES_URL, message);
    await maybeNotifyOwnerAboutSource(env, "LiveClasses", failures, message);
    throw error;
  }
}

async function refreshLostFilm(
  env: Env,
  notify: boolean
): Promise<{ scheduled: number; released: number; metadata: number }> {
  try {
    const scheduleUrls = lostFilmScheduleUrls(new Date());
    const [schedulePages, releasedEvents] = await Promise.all([
      Promise.all(scheduleUrls.map((url) => fetchText(url))),
      loadRecentLostFilmReleases()
    ]);
    const scheduledEvents = deduplicate(
      schedulePages.flatMap((html) => parseLostFilmSchedule(html)),
      (event) => event.eventKey
    );
    const scheduleChanges = await upsertLostFilmSchedule(env.DB, scheduledEvents);

    const releaseChanges = await upsertLostFilmReleases(env.DB, releasedEvents);
    const todayParts = moscowDateParts(new Date());
    await markPastLostFilmDates(env.DB, toIsoDate(todayParts.year, todayParts.month, todayParts.day));

    await recordSourceSuccess(
      env.DB,
      "lostfilm",
      LOSTFILM_URL,
      scheduledEvents.length + releasedEvents.length
    );

    let metadataUpdated = 0;
    const metadataDue = await getMetadataDue(env.DB, 4);
    const metadataResults = await Promise.all(metadataDue.map(async (item) => {
      try {
        const html = await fetchText(item.url, 5_000);
        const metadata = parseLostFilmMetadata(html, item.url);
        await saveMediaMetadata(env.DB, metadata);
        return 1;
      } catch (error) {
        console.error("failed to refresh LostFilm metadata", item.media_key, safeError(error));
        return 0;
      }
    }));
    metadataUpdated = metadataResults.reduce<number>((sum, value) => sum + value, 0);
    if (notify) {
      await notifyMediaChanges(env, scheduleChanges);
      await notifyMediaChanges(env, releaseChanges);
    }
    return {
      scheduled: scheduledEvents.length,
      released: releasedEvents.length,
      metadata: metadataUpdated
    };
  } catch (error) {
    const message = safeError(error);
    const failures = await recordSourceFailure(env.DB, "lostfilm", LOSTFILM_URL, message);
    await maybeNotifyOwnerAboutSource(env, "LostFilm", failures, message);
    throw error;
  }
}

async function loadRecentLostFilmReleases(): Promise<LostFilmEvent[]> {
  const cutoffDate = addDays(new Date(), -7).toISOString().slice(0, 10);
  const events: LostFilmEvent[] = [];
  for (let firstPage = 1; firstPage <= 9; firstPage += 3) {
    const pageNumbers = [firstPage, firstPage + 1, firstPage + 2];
    const pages = await Promise.all(pageNumbers.map((page) => fetchText(
      page === 1 ? LOSTFILM_NEW_URL : `${LOSTFILM_NEW_URL}page_${page}`
    )));
    const parsed = pages.flatMap((html) => parseLostFilmNew(html));
    events.push(...parsed.filter((event) => (event.releasedDate || "") >= cutoffDate));
    const oldestDate = parsed
      .map((event) => event.releasedDate || "9999-12-31")
      .sort()[0];
    if (!oldestDate || oldestDate < cutoffDate) break;
  }
  return deduplicate(events, (event) => event.eventKey);
}

async function refreshLostFilmMovieCatalog(
  env: Env,
  notify: boolean
): Promise<{ count: number; added: number }> {
  try {
    const initialized = await isSourceInitialized(env.DB, "lostfilm_movies");
    const payloads = await Promise.all([0, 20].map((offset) => fetchJsonForm(LOSTFILM_AJAX_URL, {
      act: "movies",
      type: "search",
      o: String(offset),
      s: "6",
      t: "0"
    })));
    const movies = deduplicate(
      payloads.flatMap((payload) => parseLostFilmMoviesCatalog(payload)),
      (movie) => movie.mediaKey
    ).map((movie, catalogRank) => ({ ...movie, catalogRank }));
    const changes = await upsertLostFilmMovieCatalog(env.DB, movies);
    await recordSourceSuccess(env.DB, "lostfilm_movies", LOSTFILM_MOVIES_URL, movies.length);
    if (notify && initialized) await notifyMovieCatalogChanges(env, changes);
    return { count: movies.length, added: changes.length };
  } catch (error) {
    const message = safeError(error);
    const failures = await recordSourceFailure(env.DB, "lostfilm_movies", LOSTFILM_MOVIES_URL, message);
    await maybeNotifyOwnerAboutSource(env, "LostFilm Movies", failures, message);
    throw error;
  }
}

async function notifyLiveChanges(env: Env, changes: LiveChange[]): Promise<void> {
  if (!changes.length) return;
  const subscriptions = await getActiveSubscriptions(env.DB, "lessons");
  for (const change of changes) {
    for (const subscription of subscriptions) {
      if (!matchesLive(subscription, change.event)) continue;
      const notificationType = change.type === "new" ? "lesson_new" : `lesson_changed:${change.event.scheduledAt || "live"}`;
      const text = change.type === "new"
        ? `Новый эфир по подписке «${subscription.filter_value}»:\n${formatLiveEvent(change.event)}`
        : `Обновилось время или состояние эфира:\n${formatLiveEvent(change.event)}`;
      await deliverOnce(env, subscription, change.event.eventKey, notificationType, text);
    }
  }
}

async function notifyUpcomingLessons(env: Env, events: LiveEvent[]): Promise<void> {
  const now = Date.now();
  const deadline = now + 60 * 60_000;
  const subscriptions = await getActiveSubscriptions(env.DB, "lessons");
  for (const event of events) {
    if (!event.scheduledAt) continue;
    const startsAt = new Date(event.scheduledAt).getTime();
    if (startsAt <= now || startsAt > deadline) continue;
    for (const subscription of subscriptions) {
      if (!matchesLive(subscription, event)) continue;
      await deliverOnce(
        env,
        subscription,
        event.eventKey,
        `lesson_reminder:${event.scheduledAt}`,
        `Эфир начнётся менее чем через час:\n${formatLiveEvent(event)}`
      );
    }
  }
}

async function notifyMediaChanges(env: Env, changes: MediaChange[]): Promise<void> {
  if (!changes.length) return;
  const subscriptions = await getActiveSubscriptions(env.DB, "media");
  for (const change of changes) {
    const genres = await getGenresForMedia(env.DB, change.event.mediaKey);
    for (const subscription of subscriptions) {
      if (!matchesMedia(subscription, change.event, genres)) continue;
      let text: string;
      let notificationType: string;
      if (change.type === "released") {
        text = `Вышло по подписке «${subscription.filter_value}»:\n${formatMediaEvent(change.event)}`;
        notificationType = `media_released:${change.event.releasedDate}`;
      } else if (change.type === "date_changed") {
        text = `Изменилась дата выхода:\n${change.event.titleRu}: ${formatDate(change.oldDate || null)} → ${formatDate(change.event.scheduledDate)}`;
        notificationType = `media_date_changed:${change.event.scheduledDate}`;
      } else {
        text = `Появилась дата выхода по подписке «${subscription.filter_value}»:\n${formatMediaEvent(change.event)}`;
        notificationType = `media_scheduled:${change.event.scheduledDate}`;
      }
      await deliverOnce(env, subscription, change.event.eventKey, notificationType, text);
    }
  }
}

async function notifyMovieCatalogChanges(env: Env, changes: MovieCatalogChange[]): Promise<void> {
  if (!changes.length) return;
  const subscriptions = await getActiveSubscriptions(env.DB, "media");
  for (const change of changes) {
    for (const subscription of subscriptions) {
      if (!matchesMovieCatalog(subscription, change.movie)) continue;
      await deliverOnce(
        env,
        subscription,
        `catalog:${change.movie.mediaKey}`,
        "media_catalog_added",
        `Новый фильм в каталоге LostFilm по подписке «${subscription.filter_value}»:\n${formatCatalogMovie(change.movie)}`
      );
    }
  }
}

async function deliverOnce(
  env: Env,
  subscription: SubscriptionRow,
  eventKey: string,
  notificationType: string,
  text: string
): Promise<void> {
  if (!(await reserveNotification(env.DB, subscription, eventKey, notificationType))) return;
  try {
    await sendMessage(env, subscription.chat_id, text);
  } catch (error) {
    await deleteNotificationReservation(env.DB, subscription, eventKey, notificationType);
    console.error("failed to deliver notification", safeError(error));
  }
}

function matchesLive(subscription: SubscriptionRow, event: LiveEvent): boolean {
  if (subscription.filter_type === "category") {
    return normalizeText(event.category).includes(subscription.filter_normalized);
  }
  return looseNormalize(event.titleNormalized).includes(looseNormalize(subscription.filter_normalized));
}

function matchesMedia(subscription: SubscriptionRow, event: LostFilmEvent, genres: string[]): boolean {
  if (subscription.media_scope !== "both" && subscription.media_scope !== event.mediaType) return false;
  if (subscription.filter_type === "genre") {
    return genres.some((genre) => normalizeText(genre).includes(subscription.filter_normalized));
  }
  return event.titleNormalized.includes(subscription.filter_normalized);
}

function matchesMovieCatalog(subscription: SubscriptionRow, movie: LostFilmMovieCatalogItem): boolean {
  if (subscription.media_scope === "series") return false;
  if (subscription.filter_type === "genre") {
    return movie.genres.some((genre) => normalizeText(genre).includes(subscription.filter_normalized));
  }
  return movie.titleNormalized.includes(subscription.filter_normalized);
}

function formatLiveEvent(event: LiveEvent): string {
  return [
    event.title,
    `${event.category}${event.author ? ` · ${event.author}` : ""}`,
    event.status === "live" ? "Сейчас в эфире" : formatMoscowDateTime(event.scheduledAt),
    event.url
  ].join("\n");
}

function formatMediaEvent(event: LostFilmEvent): string {
  const episode = event.kind === "series_episode" ? ` · ${event.season}x${String(event.episode).padStart(2, "0")}` : "";
  const date = event.status === "released" ? event.releasedDate : event.scheduledDate;
  return `${event.titleRu}${episode}\n${formatDate(date)}\n${event.url}`;
}

function formatCatalogMovie(movie: LostFilmMovieCatalogItem): string {
  const details = [
    movie.notAired ? "Скоро" : "В каталоге",
    movie.releaseYear ? String(movie.releaseYear) : "",
    movie.genres.join(", ")
  ].filter(Boolean).join(" · ");
  return `${movie.titleRu}${movie.titleEn ? ` / ${movie.titleEn}` : ""}\n${details}\n${movie.url}`;
}

async function maybeNotifyOwnerAboutSource(
  env: Env,
  source: string,
  failures: number,
  error: string
): Promise<void> {
  if (failures !== 3 || !env.OWNER_TELEGRAM_ID) return;
  await sendMessage(
    env,
    env.OWNER_TELEGRAM_ID,
    `Источник ${source} не обновился три раза подряд.\n${error}`
  ).catch(() => {});
}

function lostFilmScheduleUrls(now: Date): string[] {
  const current = moscowDateParts(now);
  const nextDate = new Date(Date.UTC(current.year, current.month, 15));
  const next = moscowDateParts(nextDate);
  const nextMonth = `${next.year}${String(next.month).padStart(2, "0")}`;
  return [LOSTFILM_URL, `https://www.lostfilm.download/schedule/type_1/month_${nextMonth}`];
}

async function fetchText(url: string, timeoutMs = 12_000): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml"
      },
      redirect: "follow",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`${new URL(url).hostname} returned HTTP ${response.status}`);
    const text = await response.text();
    if (text.length < 500) throw new Error(`${new URL(url).hostname} returned an unexpectedly short page`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonForm(url: string, form: Record<string, string>, timeoutMs = 12_000): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
      },
      body: new URLSearchParams(form).toString(),
      redirect: "follow",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`${new URL(url).hostname} returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function deduplicate<T>(items: T[], key: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}
