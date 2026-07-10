import { describe, expect, it } from "vitest";
import { parseDeterministicIntent } from "../src/intent";

describe("Russian intent fallback", () => {
  it.each([
    ["Следи за уроками по программированию", { action: "subscribe_lessons", filterType: "category", query: "Программирование" }],
    ["Когда будет урок про Blender?", { action: "query_lessons", filterType: "title", query: "Blender" }],
    ["Следи за сериалом Медведь", { action: "subscribe_media", filterType: "title", query: "Медведь", mediaScope: "series" }],
    ["Покажи новинки жанра драма", { action: "query_new", filterType: "genre", query: "драма", mediaScope: "both" }],
    ["Покажи историю выходов Медведь", { action: "query_history", query: "Медведь" }],
    ["Перестань следить за Медведем", { action: "unsubscribe", query: "Медведем" }]
  ])("parses %s", (text, expected) => {
    expect(parseDeterministicIntent(text)).toMatchObject(expected);
  });
});
