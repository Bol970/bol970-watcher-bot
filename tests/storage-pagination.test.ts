import { describe, expect, it } from "vitest";
import {
  queryLiveEvents,
  queryMovieCatalog,
  queryNewByGenre,
  queryUpcomingMedia
} from "../src/storage";

function mockDb(rows: Record<string, unknown>[]): D1Database {
  return {
    prepare: () => {
      const statement = {
        bind: () => statement,
        all: async () => ({ results: rows })
      };
      return statement;
    }
  } as unknown as D1Database;
}

describe("storage pagination", () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    event_key: `event-${index}`,
    media_key: `media-${index}`,
    title: `Урок ${index}`,
    title_ru: `Название ${index}`,
    title_en: `Title ${index}`,
    category: "Программирование",
    author: "Алексей Шадрин",
    genres_json: '["Драма"]'
  }));

  it("returns the requested page for every long-list source", async () => {
    const db = mockDb(rows);

    await expect(queryLiveEvents(db, "", 5, "all", 5))
      .resolves.toMatchObject([{ event_key: "event-5" }, { event_key: "event-6" }, { event_key: "event-7" }, { event_key: "event-8" }, { event_key: "event-9" }]);
    await expect(queryUpcomingMedia(db, "", 5, 5))
      .resolves.toMatchObject([{ event_key: "event-5" }, { event_key: "event-6" }, { event_key: "event-7" }, { event_key: "event-8" }, { event_key: "event-9" }]);
    await expect(queryMovieCatalog(db, "", false, 5, 5))
      .resolves.toMatchObject([{ media_key: "media-5" }, { media_key: "media-6" }, { media_key: "media-7" }, { media_key: "media-8" }, { media_key: "media-9" }]);
    await expect(queryNewByGenre(db, "", "2026-07-03", "both", 5, 5))
      .resolves.toMatchObject([{ event_key: "event-5" }, { event_key: "event-6" }, { event_key: "event-7" }, { event_key: "event-8" }, { event_key: "event-9" }]);
  });
});
