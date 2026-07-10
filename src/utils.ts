const MOSCOW_OFFSET_HOURS = 3;

export function cleanText(value: string | null | undefined): string {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeText(value: string | null | undefined): string {
  return cleanText(value)
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[«»“”„'’`]/g, "")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function looseNormalize(value: string | null | undefined): string {
  return normalizeText(value)
    .split(" ")
    .map(stemRussianWord)
    .join(" ");
}

function stemRussianWord(word: string): string {
  if (word.length < 5) return word;
  const endings = ["иями", "ями", "ами", "ого", "ему", "ому", "ией", "иях", "ах", "ях", "ой", "ей", "ом", "ем", "ам", "ям", "а", "я", "ы", "и", "у", "ю", "е", "ь"];
  for (const ending of endings) {
    if (word.endsWith(ending) && word.length - ending.length >= 4) {
      return word.slice(0, -ending.length);
    }
  }
  return word;
}

export function absoluteUrl(base: string, href: string): string {
  return new URL(href, base).toString();
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function toIsoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseRuDate(value: string): string | null {
  const match = cleanText(value).match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!match) return null;
  return toIsoDate(Number(match[3]), Number(match[2]), Number(match[1]));
}

export function moscowDateParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}

export function moscowLocalToIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): string {
  return new Date(Date.UTC(year, month - 1, day, hour - MOSCOW_OFFSET_HOURS, minute)).toISOString();
}

export function formatMoscowDateTime(value: string | null): string {
  if (!value) return "сейчас в эфире";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function formatDate(value: string | null): string {
  if (!value) return "дата неизвестна";
  const [year, month, day] = value.split("-");
  return `${day}.${month}.${year}`;
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

export function splitTelegramText(text: string, limit = 3900): string[] {
  const result: string[] = [];
  let remaining = text.trim();
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = remaining.lastIndexOf(" ", limit);
    if (cut < limit / 2) cut = limit;
    result.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) result.push(remaining);
  return result;
}

export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[redacted]").slice(0, 500);
}
