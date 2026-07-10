import { parse } from "node-html-parser";
import type { LiveEvent } from "../types";
import {
  absoluteUrl,
  cleanText,
  moscowDateParts,
  moscowLocalToIso,
  normalizeText,
  toIsoDate
} from "../utils";

const BASE_URL = "https://liveclasses.ru";
const MONTHS: Record<string, number> = {
  января: 1,
  февраля: 2,
  марта: 3,
  апреля: 4,
  мая: 5,
  июня: 6,
  июля: 7,
  августа: 8,
  сентября: 9,
  октября: 10,
  ноября: 11,
  декабря: 12
};

const CATEGORY_NAMES: Record<string, string> = {
  graphics: "Графика и дизайн",
  video_and_audio: "Видео и звук",
  photo: "Фотография",
  art: "Искусство",
  soft_skills: "Общее развитие",
  programming: "Программирование"
};

interface SectionDate {
  year: number;
  month: number;
  day: number;
  dateKey: string;
}

export function parseLiveClasses(html: string, now = new Date()): LiveEvent[] {
  if (!html.includes("schedule__subtitle") || !html.includes("class=\"product\"")) {
    throw new Error("LiveClasses: expected schedule markup is missing");
  }

  const sections = html.split(/<div class="schedule__header">/i).slice(1);
  const currentDate = moscowDateParts(now);
  const results: LiveEvent[] = [];

  for (const sectionHtml of sections) {
    const root = parse(`<div>${sectionHtml}</div>`);
    const subtitle = cleanText(root.querySelector(".schedule__subtitle")?.textContent);
    const isLive = /сейчас в эфире/i.test(subtitle);
    const sectionDate = isLive
      ? { ...currentDate, dateKey: toIsoDate(currentDate.year, currentDate.month, currentDate.day) }
      : parseSectionDate(subtitle, currentDate);

    if (!sectionDate) continue;

    for (const product of root.querySelectorAll(".product")) {
      const title = cleanText(product.querySelector(".product__name")?.textContent);
      const author = cleanText(product.querySelector(".product__author")?.textContent);
      const statusText = cleanText(product.querySelector(".product__status")?.textContent);
      const href = product.querySelector("a.workshop__link")?.getAttribute("href") || "";
      if (!title || !href) continue;

      const categorySlug = href.match(/\/course\/([^/]+)\//i)?.[1] || "other";
      const category = CATEGORY_NAMES[categorySlug] || categorySlug;
      const timeMatch = statusText.match(/(\d{1,2}):(\d{2})/);
      const scheduledAt = isLive || !timeMatch
        ? null
        : moscowLocalToIso(
            sectionDate.year,
            sectionDate.month,
            sectionDate.day,
            Number(timeMatch[1]),
            Number(timeMatch[2])
          );

      if (!isLive && (!scheduledAt || new Date(scheduledAt).getTime() <= now.getTime())) continue;

      const urlObject = new URL(absoluteUrl(BASE_URL, href));
      if (isLive) {
        urlObject.searchParams.set("live", "1");
        urlObject.hash = "live";
      }
      const url = urlObject.toString();
      const eventKey = `liveclasses:${new URL(url).pathname.replace(/\/$/, "")}:${sectionDate.dateKey}`;
      results.push({
        eventKey,
        title,
        titleNormalized: normalizeText(title),
        category,
        author,
        scheduledAt,
        status: isLive ? "live" : "upcoming",
        url,
        fingerprint: `${title}|${author}|${category}|${scheduledAt || "live"}|${isLive ? "live" : "upcoming"}`
      });
    }
  }

  if (!results.length) throw new Error("LiveClasses: schedule contains no current or future events");
  const deduplicated = new Map<string, LiveEvent>();
  for (const event of results) {
    const existing = deduplicated.get(event.eventKey);
    if (!existing || event.status === "live") deduplicated.set(event.eventKey, event);
  }
  return [...deduplicated.values()];
}

function parseSectionDate(
  subtitle: string,
  current: { year: number; month: number; day: number }
): SectionDate | null {
  const match = subtitle.toLocaleLowerCase("ru-RU").match(/(\d{1,2})\s+([а-яё]+)/i);
  if (!match) return null;
  const day = Number(match[1]);
  const month = MONTHS[match[2]!];
  if (!month) return null;

  let bestYear = current.year;
  let bestDistance = Number.POSITIVE_INFINITY;
  const currentUtc = Date.UTC(current.year, current.month - 1, current.day);
  for (const year of [current.year - 1, current.year, current.year + 1]) {
    const distance = Math.abs(Date.UTC(year, month - 1, day) - currentUtc);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestYear = year;
    }
  }

  return { year: bestYear, month, day, dateKey: toIsoDate(bestYear, month, day) };
}

function deduplicate<T>(items: T[], key: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}
