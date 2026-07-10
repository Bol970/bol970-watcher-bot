import { describe, expect, it } from "vitest";
import { selectLessonStages } from "../src/lesson-view";

describe("lesson timeline", () => {
  it("groups concurrent lessons into three chronological stages", () => {
    const rows = [
      { title: "Live A", status: "live", scheduled_at: null },
      { title: "Live B", status: "live", scheduled_at: null },
      { title: "Next A", status: "upcoming", scheduled_at: "2026-07-10T10:00:00.000Z" },
      { title: "Next B", status: "upcoming", scheduled_at: "2026-07-10T10:00:00.000Z" },
      { title: "Later", status: "upcoming", scheduled_at: "2026-07-10T11:00:00.000Z" },
      { title: "Not shown", status: "upcoming", scheduled_at: "2026-07-10T12:00:00.000Z" }
    ];
    const stages = selectLessonStages(rows);
    expect(stages).toHaveLength(3);
    expect(stages[0]!.rows.map((row) => row.title)).toEqual(["Live A", "Live B"]);
    expect(stages[1]!.rows.map((row) => row.title)).toEqual(["Next A", "Next B"]);
    expect(stages[2]!.rows.map((row) => row.title)).toEqual(["Later"]);
  });

  it("uses the first three future slots when nothing is live", () => {
    const rows = [
      { title: "Third", status: "upcoming", scheduled_at: "2026-07-10T12:00:00.000Z" },
      { title: "First", status: "upcoming", scheduled_at: "2026-07-10T10:00:00.000Z" },
      { title: "Second", status: "upcoming", scheduled_at: "2026-07-10T11:00:00.000Z" },
      { title: "Fourth", status: "upcoming", scheduled_at: "2026-07-10T13:00:00.000Z" }
    ];
    expect(selectLessonStages(rows).map((stage) => stage.rows[0]!.title)).toEqual(["First", "Second", "Third"]);
  });
});
