export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface Env {
  DB: D1Database;
  AI?: AiBinding;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  OWNER_TELEGRAM_ID: string;
  TEACHER_TELEGRAM_ID: string;
  BOT_DISPLAY_NAME?: string;
  WORKERS_AI_MODEL?: string;
}

export type LiveStatus = "live" | "upcoming";

export interface LiveEvent {
  eventKey: string;
  title: string;
  titleNormalized: string;
  category: string;
  author: string;
  scheduledAt: string | null;
  status: LiveStatus;
  url: string;
  fingerprint: string;
}

export type MediaType = "series" | "movie";
export type LostFilmKind = "series_episode" | "series" | "movie";

export interface LostFilmEvent {
  eventKey: string;
  mediaKey: string;
  mediaType: MediaType;
  kind: LostFilmKind;
  titleRu: string;
  titleEn: string;
  titleNormalized: string;
  season: number | null;
  episode: number | null;
  scheduledDate: string | null;
  releasedDate: string | null;
  status: "scheduled" | "released" | "date_passed";
  url: string;
}

export interface MediaMetadata {
  mediaKey: string;
  mediaType: MediaType;
  titleRu: string;
  titleEn: string;
  titleNormalized: string;
  url: string;
  genres: string[];
}

export interface LostFilmMovieCatalogItem {
  mediaKey: string;
  titleRu: string;
  titleEn: string;
  titleNormalized: string;
  url: string;
  releaseYear: number | null;
  genres: string[];
  rating: number | null;
  notAired: boolean;
  catalogRank: number;
}

export type IntentAction =
  | "help"
  | "query_lessons"
  | "query_media"
  | "query_films"
  | "query_new"
  | "query_history"
  | "subscribe_lessons"
  | "subscribe_media"
  | "unsubscribe"
  | "list_subscriptions"
  | "status"
  | "test"
  | "refresh"
  | "cancel"
  | "unknown";

export interface BotIntent {
  action: IntentAction;
  filterType?: "category" | "title" | "genre";
  query?: string;
  mediaScope?: "series" | "movie" | "both";
  onlyUpcoming?: boolean;
  fullSchedule?: boolean;
}

export interface RefreshSummary {
  busy?: boolean;
  liveCount: number;
  scheduledCount: number;
  releasedCount: number;
  catalogCount: number;
  catalogAdded: number;
  metadataUpdated: number;
  errors: string[];
}
