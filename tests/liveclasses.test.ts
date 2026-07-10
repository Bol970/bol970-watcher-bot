import { describe, expect, it } from "vitest";
import { parseLiveClasses } from "../src/parsers/liveclasses";

const product = (name: string, category: string, status: string) => `
  <div class="product">
    <div class="product__info">
      <div class="product__name">${name}</div>
      <div class="product__author">Автор Теста</div>
    </div>
    <a href="/course/${category}/${encodeURIComponent(name)}/?live=1" class="workshop__link"></a>
    <div class="product__status">${status}</div>
  </div>`;

describe("parseLiveClasses", () => {
  it("keeps live and future lessons but drops past lessons", () => {
    const html = `
      <div class="schedule">
        <div class="schedule__header"><div class="schedule__subtitle">Сейчас в эфире</div></div>
        <div class="product-list__wrapper">${product("Прямой эфир", "programming", "Идёт трансляция")}</div>
        <div class="schedule__header"><div class="schedule__subtitle">Сегодня, 10 Июля</div></div>
        <div class="product-list__wrapper">
          ${product("Прошедший урок", "photo", "Начнётся в 08:00 (Московское время)")}
          ${product("Будущий урок", "programming", "Начнётся в 10:00 (Московское время)")}
        </div>
      </div>`;

    const events = parseLiveClasses(html, new Date("2026-07-10T06:00:00Z"));
    expect(events.map((event) => event.title)).toEqual(["Прямой эфир", "Будущий урок"]);
    expect(events[0]!.url).toBe("https://liveclasses.ru/course/programming/%D0%9F%D1%80%D1%8F%D0%BC%D0%BE%D0%B9%20%D1%8D%D1%84%D0%B8%D1%80/?live=1");
    expect(events[1]).toMatchObject({
      category: "Программирование",
      scheduledAt: "2026-07-10T07:00:00.000Z",
      status: "upcoming"
    });
    expect(events.every((event) => !event.url.includes("#live"))).toBe(true);
  });

  it("infers the next year for a January schedule shown in December", () => {
    const html = `
      <div class="schedule">
        <div class="schedule__header"><div class="schedule__subtitle">Завтра, 1 Января</div></div>
        <div class="product-list__wrapper">${product("Новогодний урок", "art", "Начнётся в 01:00 (Московское время)")}</div>
      </div>`;
    const [event] = parseLiveClasses(html, new Date("2026-12-31T20:00:00Z"));
    expect(event!.scheduledAt).toBe("2026-12-31T22:00:00.000Z");
    expect(event!.eventKey).toContain("2027-01-01");
  });

  it("rejects an unexpected page instead of deleting cached data", () => {
    expect(() => parseLiveClasses("<html>maintenance</html>")).toThrow(/expected schedule markup/);
  });
});
