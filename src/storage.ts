import type { LiveEvent, LostFilmEvent, MediaMetadata } from "./types";
import { addMinutes, isoNow, looseNormalize, normalizeText, randomId, sha256 } from "./utils";

export interface LiveChange {
  type: "new" | "changed";
  event: LiveEvent;
}

export interface MediaChange {
  type: "new_schedule" | "date_changed" | "released";
  event: LostFilmEvent;
  oldDate?: string | null;
}

export interface SubscriptionRow {
  id: string;
  telegram_id: string;
  chat_id: string;
  domain: "lessons" | "media";
  filter_type: "category" | "title" | "genre";
  filter_value: string;
  filter_normalized: string;
  media_scope: "series" | "movie" | "both";
}

export async function ensureUser(
  db: D1Database,
  telegramId: string,
  chatId: string,
  role: "owner" | "teacher"
): Promise<void> {
  const now = isoNow();
  await db.prepare(`
    INSERT INTO users (telegram_id, chat_id, role, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      chat_id = excluded.chat_id,
      role = excluded.role,
      last_seen_at = excluded.last_seen_at
  `).bind(telegramId, chatId, role, now, now).run();
}

export async function acquireRefreshLock(db: D1Database, name = "sources"): Promise<boolean> {
  const now = new Date();
  const lockedUntil = addMinutes(now, 10).toISOString();
  const row = await db.prepare(`
    INSERT INTO refresh_locks (name, locked_until, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      locked_until = excluded.locked_until,
      updated_at = excluded.updated_at
    WHERE refresh_locks.locked_until <= ?
    RETURNING name
  `).bind(name, lockedUntil, now.toISOString(), now.toISOString()).first<{ name: string }>();
  return Boolean(row?.name);
}

export async function releaseRefreshLock(db: D1Database, name = "sources"): Promise<void> {
  await db.prepare("DELETE FROM refresh_locks WHERE name = ?").bind(name).run();
}

export async function recordSourceSuccess(
  db: D1Database,
  source: string,
  url: string,
  itemCount: number
): Promise<void> {
  const now = isoNow();
  await db.prepare(`
    INSERT INTO source_state (
      source, url, last_checked_at, last_success_at, last_error,
      consecutive_failures, last_item_count, updated_at
    ) VALUES (?, ?, ?, ?, NULL, 0, ?, ?)
    ON CONFLICT(source) DO UPDATE SET
      url = excluded.url,
      last_checked_at = excluded.last_checked_at,
      last_success_at = excluded.last_success_at,
      last_error = NULL,
      consecutive_failures = 0,
      last_item_count = excluded.last_item_count,
      updated_at = excluded.updated_at
  `).bind(source, url, now, now, itemCount, now).run();
}

export async function recordSourceFailure(
  db: D1Database,
  source: string,
  url: string,
  error: string
): Promise<number> {
  const now = isoNow();
  await db.prepare(`
    INSERT INTO source_state (
      source, url, last_checked_at, last_error, consecutive_failures,
      last_item_count, updated_at
    ) VALUES (?, ?, ?, ?, 1, 0, ?)
    ON CONFLICT(source) DO UPDATE SET
      url = excluded.url,
      last_checked_at = excluded.last_checked_at,
      last_error = excluded.last_error,
      consecutive_failures = source_state.consecutive_failures + 1,
      updated_at = excluded.updated_at
  `).bind(source, url, now, error, now).run();
  const row = await db.prepare("SELECT consecutive_failures FROM source_state WHERE source = ?")
    .bind(source).first<{ consecutive_failures: number }>();
  return Number(row?.consecutive_failures || 1);
}

export async function getSourceStates(db: D1Database): Promise<Record<string, unknown>[]> {
  const result = await db.prepare(`
    SELECT source, url, last_checked_at, last_success_at, last_error,
           consecutive_failures, last_item_count
    FROM source_state
    ORDER BY source
  `).all<Record<string, unknown>>();
  return result.results || [];
}

export async function syncLiveEvents(db: D1Database, events: LiveEvent[]): Promise<LiveChange[]> {
  const existingResult = await db.prepare(`
    SELECT event_key, fingerprint FROM live_events
  `).all<{ event_key: string; fingerprint: string }>();
  const existing = new Map((existingResult.results || []).map((row) => [row.event_key, row]));
  const now = isoNow();
  const changes: LiveChange[] = [];
  const statements: D1PreparedStatement[] = [];

  for (const event of events) {
    const fingerprint = await sha256(event.fingerprint);
    const old = existing.get(event.eventKey);
    if (!old) changes.push({ type: "new", event });
    else if (old.fingerprint !== fingerprint) changes.push({ type: "changed", event });

    statements.push(db.prepare(`
      INSERT INTO live_events (
        event_key, title, title_normalized, category, category_normalized, author, scheduled_at,
        status, url, fingerprint, first_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_key) DO UPDATE SET
        title = excluded.title,
        title_normalized = excluded.title_normalized,
        category = excluded.category,
        category_normalized = excluded.category_normalized,
        author = excluded.author,
        scheduled_at = excluded.scheduled_at,
        status = excluded.status,
        url = excluded.url,
        fingerprint = excluded.fingerprint,
        updated_at = excluded.updated_at
    `).bind(
      event.eventKey,
      event.title,
      event.titleNormalized,
      event.category,
      normalizeText(event.category),
      event.author || null,
      event.scheduledAt,
      event.status,
      event.url,
      fingerprint,
      now,
      now
    ));
  }

  const currentKeys = new Set(events.map((event) => event.eventKey));
  for (const oldKey of existing.keys()) {
    if (!currentKeys.has(oldKey)) {
      statements.push(db.prepare("DELETE FROM live_events WHERE event_key = ?").bind(oldKey));
    }
  }
  for (let index = 0; index < statements.length; index += 50) {
    await db.batch(statements.slice(index, index + 50));
  }
  return changes;
}

export async function upsertLostFilmSchedule(
  db: D1Database,
  events: LostFilmEvent[]
): Promise<MediaChange[]> {
  const now = isoNow();
  const changes: MediaChange[] = [];

  for (const event of events) {
    await ensureMediaPlaceholder(db, event, now);
    const old = await db.prepare(`
      SELECT scheduled_date, status FROM lostfilm_events WHERE event_key = ?
    `).bind(event.eventKey).first<{ scheduled_date: string | null; status: string }>();

    if (!old) {
      changes.push({ type: "new_schedule", event });
    } else if (old.scheduled_date !== event.scheduledDate) {
      changes.push({ type: "date_changed", event, oldDate: old.scheduled_date });
      await db.prepare(`
        INSERT INTO lostfilm_date_history (event_key, old_date, new_date, observed_at)
        VALUES (?, ?, ?, ?)
      `).bind(event.eventKey, old.scheduled_date, event.scheduledDate, now).run();
    }

    await db.prepare(`
      INSERT INTO lostfilm_events (
        event_key, media_key, kind, title_ru, title_en, title_normalized,
        season, episode, scheduled_date, first_scheduled_date, released_date,
        status, url, first_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'scheduled', ?, ?, ?)
      ON CONFLICT(event_key) DO UPDATE SET
        media_key = excluded.media_key,
        kind = excluded.kind,
        title_ru = excluded.title_ru,
        title_en = CASE WHEN excluded.title_en != '' THEN excluded.title_en ELSE lostfilm_events.title_en END,
        title_normalized = excluded.title_normalized,
        season = excluded.season,
        episode = excluded.episode,
        scheduled_date = excluded.scheduled_date,
        status = CASE WHEN lostfilm_events.status = 'released' THEN 'released' ELSE 'scheduled' END,
        url = excluded.url,
        updated_at = excluded.updated_at
    `).bind(
      event.eventKey,
      event.mediaKey,
      event.kind,
      event.titleRu,
      event.titleEn,
      event.titleNormalized,
      event.season,
      event.episode,
      event.scheduledDate,
      event.scheduledDate,
      event.url,
      now,
      now
    ).run();
  }
  return changes;
}

export async function upsertLostFilmReleases(
  db: D1Database,
  events: LostFilmEvent[]
): Promise<MediaChange[]> {
  const now = isoNow();
  const changes: MediaChange[] = [];
  for (const event of events) {
    await ensureMediaPlaceholder(db, event, now);
    const old = await db.prepare(`
      SELECT status, scheduled_date FROM lostfilm_events WHERE event_key = ?
    `).bind(event.eventKey).first<{ status: string; scheduled_date: string | null }>();
    if (!old || old.status !== "released") changes.push({ type: "released", event });

    await db.prepare(`
      INSERT INTO lostfilm_events (
        event_key, media_key, kind, title_ru, title_en, title_normalized,
        season, episode, scheduled_date, first_scheduled_date, released_date,
        status, url, first_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'released', ?, ?, ?)
      ON CONFLICT(event_key) DO UPDATE SET
        media_key = excluded.media_key,
        kind = excluded.kind,
        title_ru = excluded.title_ru,
        title_en = CASE WHEN excluded.title_en != '' THEN excluded.title_en ELSE lostfilm_events.title_en END,
        title_normalized = excluded.title_normalized,
        season = excluded.season,
        episode = excluded.episode,
        scheduled_date = COALESCE(lostfilm_events.scheduled_date, excluded.scheduled_date),
        released_date = excluded.released_date,
        status = 'released',
        url = excluded.url,
        updated_at = excluded.updated_at
    `).bind(
      event.eventKey,
      event.mediaKey,
      event.kind,
      event.titleRu,
      event.titleEn,
      event.titleNormalized,
      event.season,
      event.episode,
      event.scheduledDate,
      event.scheduledDate,
      event.releasedDate,
      event.url,
      now,
      now
    ).run();
  }
  return changes;
}

export async function markPastLostFilmDates(db: D1Database, today: string): Promise<void> {
  await db.prepare(`
    UPDATE lostfilm_events
    SET status = 'date_passed', updated_at = ?
    WHERE status = 'scheduled' AND scheduled_date < ?
  `).bind(isoNow(), today).run();
}

export async function getMetadataDue(db: D1Database, limit = 20): Promise<{ media_key: string; url: string }[]> {
  const threshold = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const result = await db.prepare(`
    SELECT media_key, url
    FROM media_titles
    WHERE metadata_checked_at IS NULL OR metadata_checked_at < ?
    ORDER BY metadata_checked_at IS NOT NULL, created_at DESC
    LIMIT ?
  `).bind(threshold, limit).all<{ media_key: string; url: string }>();
  return result.results || [];
}

export async function saveMediaMetadata(db: D1Database, metadata: MediaMetadata): Promise<void> {
  const now = isoNow();
  await db.prepare(`
    INSERT INTO media_titles (
      media_key, media_type, title_ru, title_en, title_normalized, url,
      genres_json, metadata_checked_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(media_key) DO UPDATE SET
      media_type = excluded.media_type,
      title_ru = excluded.title_ru,
      title_en = excluded.title_en,
      title_normalized = excluded.title_normalized,
      url = excluded.url,
      genres_json = excluded.genres_json,
      metadata_checked_at = excluded.metadata_checked_at,
      updated_at = excluded.updated_at
  `).bind(
    metadata.mediaKey,
    metadata.mediaType,
    metadata.titleRu,
    metadata.titleEn || null,
    metadata.titleNormalized,
    metadata.url,
    JSON.stringify(metadata.genres),
    now,
    now,
    now
  ).run();
}

export async function getActiveSubscriptions(db: D1Database, domain: "lessons" | "media"): Promise<SubscriptionRow[]> {
  const result = await db.prepare(`
    SELECT s.id, s.telegram_id, u.chat_id, s.domain, s.filter_type,
           s.filter_value, s.filter_normalized, s.media_scope
    FROM subscriptions s
    JOIN users u ON u.telegram_id = s.telegram_id
    WHERE s.active = 1 AND s.domain = ?
  `).bind(domain).all<SubscriptionRow>();
  return result.results || [];
}

export async function addSubscription(
  db: D1Database,
  input: {
    telegramId: string;
    domain: "lessons" | "media";
    filterType: "category" | "title" | "genre";
    filterValue: string;
    mediaScope?: "series" | "movie" | "both";
  }
): Promise<{ id: string; created: boolean }> {
  const normalized = normalizeText(input.filterValue);
  const scope = input.mediaScope || "both";
  const existing = await db.prepare(`
    SELECT id, active FROM subscriptions
    WHERE telegram_id = ? AND domain = ? AND filter_type = ?
      AND filter_normalized = ? AND media_scope = ?
  `).bind(input.telegramId, input.domain, input.filterType, normalized, scope)
    .first<{ id: string; active: number }>();
  const now = isoNow();
  if (existing) {
    await db.prepare(`
      UPDATE subscriptions SET active = 1, filter_value = ?, updated_at = ? WHERE id = ?
    `).bind(input.filterValue, now, existing.id).run();
    return { id: existing.id, created: existing.active !== 1 };
  }

  const id = randomId("sub");
  await db.prepare(`
    INSERT INTO subscriptions (
      id, telegram_id, domain, filter_type, filter_value, filter_normalized,
      media_scope, active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).bind(
    id,
    input.telegramId,
    input.domain,
    input.filterType,
    input.filterValue,
    normalized,
    scope,
    now,
    now
  ).run();
  return { id, created: true };
}

export async function listSubscriptions(db: D1Database, telegramId: string): Promise<Record<string, unknown>[]> {
  const result = await db.prepare(`
    SELECT id, domain, filter_type, filter_value, media_scope, created_at
    FROM subscriptions
    WHERE telegram_id = ? AND active = 1
    ORDER BY created_at
  `).bind(telegramId).all<Record<string, unknown>>();
  return result.results || [];
}

export async function deactivateSubscriptions(db: D1Database, telegramId: string, query: string): Promise<number> {
  const normalized = normalizeText(query);
  const result = await db.prepare(`
    UPDATE subscriptions
    SET active = 0, updated_at = ?
    WHERE telegram_id = ? AND active = 1
      AND (filter_normalized = ? OR filter_normalized LIKE ? OR ? LIKE '%' || filter_normalized || '%')
  `).bind(isoNow(), telegramId, normalized, `%${normalized}%`, normalized).run();
  return Number(result.meta.changes || 0);
}

export async function reserveNotification(
  db: D1Database,
  subscription: SubscriptionRow,
  eventKey: string,
  notificationType: string
): Promise<boolean> {
  const key = await sha256(`${subscription.id}|${eventKey}|${notificationType}`);
  const result = await db.prepare(`
    INSERT OR IGNORE INTO notification_log (
      notification_key, telegram_id, subscription_id, event_key, notification_type, sent_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(key, subscription.telegram_id, subscription.id, eventKey, notificationType, isoNow()).run();
  return Number(result.meta.changes || 0) > 0;
}

export async function deleteNotificationReservation(
  db: D1Database,
  subscription: SubscriptionRow,
  eventKey: string,
  notificationType: string
): Promise<void> {
  const key = await sha256(`${subscription.id}|${eventKey}|${notificationType}`);
  await db.prepare("DELETE FROM notification_log WHERE notification_key = ?").bind(key).run();
}

export async function saveDialogSession(
  db: D1Database,
  telegramId: string,
  chatId: string,
  step: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  const now = new Date();
  await db.prepare(`
    INSERT INTO dialog_sessions (telegram_id, chat_id, step, payload_json, expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      chat_id = excluded.chat_id,
      step = excluded.step,
      payload_json = excluded.payload_json,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `).bind(
    telegramId,
    chatId,
    step,
    JSON.stringify(payload),
    addMinutes(now, 15).toISOString(),
    now.toISOString()
  ).run();
}

export async function getDialogSession(
  db: D1Database,
  telegramId: string
): Promise<{ step: string; payload: Record<string, unknown> } | null> {
  const row = await db.prepare(`
    SELECT step, payload_json FROM dialog_sessions
    WHERE telegram_id = ? AND expires_at > ?
  `).bind(telegramId, isoNow()).first<{ step: string; payload_json: string }>();
  if (!row) return null;
  try {
    return { step: row.step, payload: JSON.parse(row.payload_json) as Record<string, unknown> };
  } catch {
    return { step: row.step, payload: {} };
  }
}

export async function clearDialogSession(db: D1Database, telegramId: string): Promise<void> {
  await db.prepare("DELETE FROM dialog_sessions WHERE telegram_id = ?").bind(telegramId).run();
}

export async function queryLiveEvents(db: D1Database, query = "", limit = 20): Promise<Record<string, unknown>[]> {
  const normalized = normalizeText(query);
  const result = await db.prepare(`
    SELECT event_key, title, category, author, scheduled_at, status, url
    FROM live_events
    WHERE (? = '' OR title_normalized LIKE ? OR category_normalized LIKE ?)
    ORDER BY status = 'live' DESC, scheduled_at ASC
    LIMIT ?
  `).bind(normalized, `%${normalized}%`, `%${normalized}%`, limit).all<Record<string, unknown>>();
  return result.results || [];
}

export async function queryUpcomingMedia(db: D1Database, query = "", limit = 20): Promise<Record<string, unknown>[]> {
  const result = await db.prepare(`
    SELECT event_key, kind, title_ru, title_en, season, episode,
           scheduled_date, released_date, status, url
    FROM lostfilm_events
    WHERE status IN ('scheduled', 'date_passed')
    ORDER BY scheduled_date ASC
    LIMIT 200
  `).all<Record<string, unknown>>();
  const needle = looseNormalize(query);
  return (result.results || [])
    .filter((row) => !needle || looseNormalize(String(row.title_ru || "")).includes(needle))
    .slice(0, limit);
}

export async function queryNewByGenre(db: D1Database, genre: string, sinceDate: string, limit = 20): Promise<Record<string, unknown>[]> {
  const normalized = normalizeText(genre);
  const result = await db.prepare(`
    SELECT e.event_key, e.kind, e.title_ru, e.title_en, e.season, e.episode,
           e.released_date, e.url, m.genres_json
    FROM lostfilm_events e
    JOIN media_titles m ON m.media_key = e.media_key
    WHERE e.status = 'released' AND e.released_date >= ?
    ORDER BY e.released_date DESC, e.title_ru
    LIMIT 100
  `).bind(sinceDate).all<Record<string, unknown>>();
  return (result.results || []).filter((row) => {
    try {
      const genres = JSON.parse(String(row.genres_json || "[]")) as string[];
      return !normalized || genres.some((item) => normalizeText(item).includes(normalized));
    } catch {
      return false;
    }
  }).slice(0, limit);
}

export async function queryMediaHistory(db: D1Database, query: string, limit = 30): Promise<Record<string, unknown>[]> {
  const result = await db.prepare(`
    SELECT event_key, kind, title_ru, title_en, season, episode,
           scheduled_date, first_scheduled_date, released_date, status, url
    FROM lostfilm_events
    ORDER BY COALESCE(released_date, scheduled_date) DESC
    LIMIT 500
  `).all<Record<string, unknown>>();
  const needle = looseNormalize(query);
  return (result.results || [])
    .filter((row) => looseNormalize(String(row.title_ru || "")).includes(needle))
    .slice(0, limit);
}

export async function resolveMediaTitle(
  db: D1Database,
  query: string,
  scope: "series" | "movie" | "both" = "both"
): Promise<string> {
  const result = await db.prepare(`
    SELECT title_ru, media_type FROM media_titles ORDER BY updated_at DESC LIMIT 500
  `).all<{ title_ru: string; media_type: "series" | "movie" }>();
  const needle = looseNormalize(query);
  const matches = (result.results || []).filter((row) =>
    (scope === "both" || row.media_type === scope) &&
    (looseNormalize(row.title_ru) === needle || looseNormalize(row.title_ru).includes(needle))
  );
  return matches[0]?.title_ru || query;
}

export async function getGenresForMedia(db: D1Database, mediaKey: string): Promise<string[]> {
  const row = await db.prepare("SELECT genres_json FROM media_titles WHERE media_key = ?")
    .bind(mediaKey).first<{ genres_json: string }>();
  try {
    return JSON.parse(row?.genres_json || "[]") as string[];
  } catch {
    return [];
  }
}

async function ensureMediaPlaceholder(db: D1Database, event: LostFilmEvent, now: string): Promise<void> {
  const detailsUrl = event.mediaType === "series"
    ? event.url.replace(/\/season_\d+.*$/i, "/")
    : event.url.replace(/\/$/, "");
  await db.prepare(`
    INSERT INTO media_titles (
      media_key, media_type, title_ru, title_en, title_normalized,
      url, genres_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)
    ON CONFLICT(media_key) DO UPDATE SET
      title_ru = excluded.title_ru,
      title_en = CASE WHEN excluded.title_en != '' THEN excluded.title_en ELSE media_titles.title_en END,
      title_normalized = excluded.title_normalized,
      url = excluded.url,
      updated_at = excluded.updated_at
  `).bind(
    event.mediaKey,
    event.mediaType,
    event.titleRu,
    event.titleEn,
    event.titleNormalized,
    detailsUrl,
    now,
    now
  ).run();
}
