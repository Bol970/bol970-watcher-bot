import { parse, type HTMLElement } from "node-html-parser";
import type { LostFilmEvent, MediaMetadata, MediaType } from "../types";
import { absoluteUrl, cleanText, normalizeText, parseRuDate, toIsoDate } from "../utils";

const BASE_URL = "https://www.lostfilm.download";
const MONTHS: Record<string, number> = {
  январь: 1,
  февраль: 2,
  март: 3,
  апрель: 4,
  май: 5,
  июнь: 6,
  июль: 7,
  август: 8,
  сентябрь: 9,
  октябрь: 10,
  ноябрь: 11,
  декабрь: 12
};

interface ParsedHref {
  mediaKey: string;
  mediaType: MediaType;
  kind: LostFilmEvent["kind"];
  season: number | null;
  episode: number | null;
  canonicalPath: string;
  detailsUrl: string;
}

export function parseLostFilmSchedule(html: string): LostFilmEvent[] {
  const root = parse(html);
  const activeMonthText = cleanText(root.querySelector(".active-month")?.textContent).toLocaleLowerCase("ru-RU");
  const monthMatch = activeMonthText.match(/([а-яё]+)\s+(\d{4})/i);
  const activeMonth = monthMatch ? MONTHS[monthMatch[1]!] : undefined;
  const activeYear = monthMatch ? Number(monthMatch[2]) : 0;
  if (!activeMonth || !activeYear) throw new Error("LostFilm: active schedule month is missing");

  const results: LostFilmEvent[] = [];
  for (const table of root.querySelectorAll("table.schedule-list-table")) {
    let datesByColumn = new Map<number, string>();
    for (const row of table.querySelectorAll("tr")) {
      const headers = row.querySelectorAll("th");
      if (headers.length) {
        datesByColumn = new Map<number, string>();
        headers.forEach((header, index) => {
          const match = cleanText(header.textContent).match(/(\d{1,2})\.(\d{2})/);
          if (!match) return;
          const day = Number(match[1]);
          const month = Number(match[2]);
          let year = activeYear;
          if (activeMonth === 1 && month === 12) year -= 1;
          if (activeMonth === 12 && month === 1) year += 1;
          datesByColumn.set(index, toIsoDate(year, month, day));
        });
        continue;
      }

      const cells = row.querySelectorAll("td");
      cells.forEach((cell, index) => {
        const anchor = cell.querySelector("a.title");
        const scheduledDate = datesByColumn.get(index);
        if (!anchor || !scheduledDate) return;
        const event = eventFromAnchor(anchor, scheduledDate, null);
        if (event) results.push(event);
      });
    }
  }

  if (!results.length) throw new Error("LostFilm: schedule contains no events");
  return deduplicate(results, (event) => event.eventKey);
}

export function parseLostFilmNew(html: string): LostFilmEvent[] {
  const root = parse(html);
  const rows = root.querySelectorAll(".content.history .serials-list .row");
  if (!rows.length) throw new Error("LostFilm: new releases markup is missing");

  const results: LostFilmEvent[] = [];
  for (const row of rows) {
    const anchor = row
      .querySelectorAll("a")
      .find((candidate) => /^\/(series|movies)\//.test(candidate.getAttribute("href") || ""));
    if (!anchor) continue;
    const href = anchor.getAttribute("href") || "";
    const parsedHref = parseMediaHref(href);
    const releasedDate = parseRuDate(cleanText(row.querySelector(".overlay .right-part")?.textContent));
    const titleRu = cleanText(row.querySelector(".name-ru")?.textContent);
    const titleEn = cleanText(row.querySelector(".name-en")?.textContent);
    if (!parsedHref || !releasedDate || !titleRu) continue;

    results.push({
      eventKey: `lostfilm:${parsedHref.canonicalPath}`,
      mediaKey: parsedHref.mediaKey,
      mediaType: parsedHref.mediaType,
      kind: parsedHref.kind,
      titleRu,
      titleEn,
      titleNormalized: normalizeText(titleRu),
      season: parsedHref.season,
      episode: parsedHref.episode,
      scheduledDate: releasedDate,
      releasedDate,
      status: "released",
      url: absoluteUrl(BASE_URL, href)
    });
  }

  return deduplicate(results, (event) => event.eventKey);
}

export function parseLostFilmMetadata(html: string, sourceUrl: string): MediaMetadata {
  const root = parse(html);
  const titleRu = cleanText(root.querySelector('[itemprop="name"]')?.textContent);
  const titleEn = cleanText(root.querySelector('[itemprop="alternativeHeadline"]')?.textContent);
  const genres = root
    .querySelectorAll('[itemprop="genre"] a')
    .map((anchor) => cleanText(anchor.textContent))
    .filter(Boolean);
  const parsedHref = parseMediaHref(new URL(sourceUrl).pathname);
  if (!parsedHref || !titleRu) throw new Error("LostFilm: media metadata is incomplete");

  return {
    mediaKey: parsedHref.mediaKey,
    mediaType: parsedHref.mediaType,
    titleRu,
    titleEn,
    titleNormalized: normalizeText(titleRu),
    url: parsedHref.detailsUrl,
    genres: [...new Set(genres)]
  };
}

export function detailsUrlForEvent(event: LostFilmEvent): string {
  const parsed = parseMediaHref(new URL(event.url).pathname);
  if (!parsed) throw new Error(`LostFilm: unsupported event URL ${event.url}`);
  return parsed.detailsUrl;
}

function eventFromAnchor(
  anchor: HTMLElement,
  scheduledDate: string,
  releasedDate: string | null
): LostFilmEvent | null {
  const href = anchor.getAttribute("href") || "";
  const parsedHref = parseMediaHref(href);
  if (!parsedHref) return null;
  const titleHtml = anchor.innerHTML.split(/<br\s*\/?\s*>/i)[0] || "";
  const titleRu = cleanText(parse(`<span>${titleHtml}</span>`).textContent);
  if (!titleRu) return null;

  return {
    eventKey: `lostfilm:${parsedHref.canonicalPath}`,
    mediaKey: parsedHref.mediaKey,
    mediaType: parsedHref.mediaType,
    kind: parsedHref.kind,
    titleRu,
    titleEn: "",
    titleNormalized: normalizeText(titleRu),
    season: parsedHref.season,
    episode: parsedHref.episode,
    scheduledDate,
    releasedDate,
    status: releasedDate ? "released" : "scheduled",
    url: absoluteUrl(BASE_URL, href)
  };
}

function parseMediaHref(href: string): ParsedHref | null {
  const pathname = new URL(href, BASE_URL).pathname;
  const series = pathname.match(/^\/series\/([^/]+)(?:\/season_(\d+))?(?:\/episode_(\d+))?/i);
  if (series) {
    const slug = series[1];
    const season = series[2] ? Number(series[2]) : null;
    const episode = series[3] ? Number(series[3]) : null;
    const canonicalPath = episode
      ? `series/${slug}/season_${season}/episode_${episode}`
      : season
        ? `series/${slug}/season_${season}`
        : `series/${slug}`;
    return {
      mediaKey: `series:${slug}`,
      mediaType: "series",
      kind: episode ? "series_episode" : "series",
      season,
      episode,
      canonicalPath,
      detailsUrl: `${BASE_URL}/series/${slug}/`
    };
  }

  const movie = pathname.match(/^\/movies\/([^/]+)/i);
  if (movie) {
    const slug = movie[1];
    return {
      mediaKey: `movie:${slug}`,
      mediaType: "movie",
      kind: "movie",
      season: null,
      episode: null,
      canonicalPath: `movies/${slug}`,
      detailsUrl: `${BASE_URL}/movies/${slug}`
    };
  }
  return null;
}

function deduplicate<T>(items: T[], key: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}
