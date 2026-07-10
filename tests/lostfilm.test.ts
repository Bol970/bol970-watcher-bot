import { describe, expect, it } from "vitest";
import {
  parseLostFilmMetadata,
  parseLostFilmMoviesCatalog,
  parseLostFilmNew,
  parseLostFilmSchedule
} from "../src/parsers/lostfilm";

describe("LostFilm parsers", () => {
  it("maps schedule columns to dates and distinguishes series from movies", () => {
    const html = `
      <div class="active-month">июль 2026 г.</div>
      <table class="schedule-list-table"><tbody>
        <tr><th></th><th>Ср 01.07</th><th>Чт 02.07</th><th></th></tr>
        <tr>
          <td class="placeholder"></td>
          <td><a class="title" href="/series/The_Bear/season_5/episode_7/">Медведь<br><span>5х07</span></a></td>
          <td><a class="title" href="/movies/Test_Movie">Тестовый фильм</a></td>
          <td class="placeholder"></td>
        </tr>
      </tbody></table>`;
    const events = parseLostFilmSchedule(html);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      mediaKey: "series:The_Bear",
      season: 5,
      episode: 7,
      scheduledDate: "2026-07-01"
    });
    expect(events[1]).toMatchObject({
      mediaKey: "movie:Test_Movie",
      kind: "movie",
      scheduledDate: "2026-07-02"
    });
  });

  it("parses released episodes and films", () => {
    const html = `
      <div class="content history"><div class="serials-list">
        <div class="row">
          <a href="/series/The_Bear/season_5/episode_6/">
            <div class="overlay"><div class="right-part">08.07.2026</div></div>
            <div class="name-ru">Медведь</div><div class="name-en">The Bear</div>
          </a>
        </div>
        <div class="row">
          <a href="/movies/Test_Movie">
            <div class="overlay"><div class="right-part">07.07.2026</div></div>
            <div class="name-ru">Тестовый фильм</div><div class="name-en">Test Movie</div>
          </a>
        </div>
      </div></div>`;
    const events = parseLostFilmNew(html);
    expect(events.map((event) => event.status)).toEqual(["released", "released"]);
    expect(events[0]!.releasedDate).toBe("2026-07-08");
    expect(events[1]!.mediaType).toBe("movie");
  });

  it("extracts and deduplicates genres from a title page", () => {
    const html = `
      <div itemscope itemtype="http://schema.org/TVSeries">
        <h1 itemprop="name">Медведь</h1>
        <h2 itemprop="alternativeHeadline">The Bear</h2>
        <span itemprop="genre"><a>Комедия</a>, <a>Драма</a>, <a>Комедия</a></span>
      </div>`;
    const metadata = parseLostFilmMetadata(html, "https://www.lostfilm.download/series/The_Bear/");
    expect(metadata.genres).toEqual(["Комедия", "Драма"]);
    expect(metadata.mediaKey).toBe("series:The_Bear");
  });

  it("parses the movie catalog JSON with genres and upcoming status", () => {
    const movies = parseLostFilmMoviesCatalog({
      result: "ok",
      data: [
        {
          alias: "Dune_Part_Three",
          title: "Дюна: Часть третья",
          title_orig: "Dune: Part Three",
          date: "2026",
          genres: "Драма, Боевик, Научная фантастика",
          rating: 8.7,
          not_aired: true,
          link: "/movies/Dune_Part_Three",
          ismovie: "1"
        }
      ]
    });
    expect(movies).toEqual([expect.objectContaining({
      mediaKey: "movie:Dune_Part_Three",
      releaseYear: 2026,
      genres: ["Драма", "Боевик", "Научная фантастика"],
      rating: 8.7,
      notAired: true,
      catalogRank: 0
    })]);
  });

  it("rejects an invalid movie catalog response", () => {
    expect(() => parseLostFilmMoviesCatalog({ result: "error" })).toThrow(/movie catalog response/);
  });
});
