import { describe, expect, it } from "vitest";
import { parseDeterministicIntent } from "../src/intent";

describe("Russian intent fallback", () => {
  it.each([
    ["Следи за уроками по программированию", { action: "subscribe_lessons", filterType: "category", query: "Программирование" }],
    ["Когда будет урок про Blender?", { action: "query_lessons", filterType: "title", query: "Blender" }],
    ["Покажи все эфиры по программированию", { action: "query_lessons", filterType: "category", query: "Программирование", fullSchedule: true }],
    ["Следи за сериалом Медведь", { action: "subscribe_media", filterType: "title", query: "Медведь", mediaScope: "series" }],
    ["Покажи новинки жанра драма", { action: "query_new", filterType: "genre", query: "драма", mediaScope: "both" }],
    ["Покажи новинки фильмов жанра драма", { action: "query_new", filterType: "genre", query: "драма", mediaScope: "movie" }],
    ["Покажи фильмы жанра фантастика", { action: "query_films", query: "фантастика", mediaScope: "movie" }],
    ["Какие фильмы скоро выйдут?", { action: "query_films", query: "", mediaScope: "movie", onlyUpcoming: true }],
    ["Следи за новыми фильмами жанра драма", { action: "subscribe_media", filterType: "genre", query: "драма", mediaScope: "movie" }],
    ["Покажи историю выходов Медведь", { action: "query_history", query: "Медведь" }],
    ["Перестань следить за Медведем", { action: "unsubscribe", query: "Медведем" }]
  ])("parses %s", (text, expected) => {
    expect(parseDeterministicIntent(text)).toMatchObject(expected);
  });
});
