import { describe, expect, it } from "vitest";
import { selectLessonStages } from "../src/lesson-view";

describe("lesson timeline", () => {
  it("returns up to five live lessons and two batches of five future lessons", () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, index) => ({ title: `Live ${index + 1}`, status: "live", scheduled_at: null })),
      ...Array.from({ length: 12 }, (_, index) => ({
        title: `Future ${index + 1}`,
        status: "upcoming",
        scheduled_at: `2026-07-10T${String(10 + Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "10" : "00"}:00.000Z`
      }))
    ];
    const stages = selectLessonStages(rows);
    expect(stages).toHaveLength(3);
    expect(stages.map((stage) => stage.rows)).toHaveLength(3);
    expect(stages.map((stage) => stage.rows.length)).toEqual([5, 5, 5]);
    expect(stages[1]!.rows.map((row) => row.title)).toEqual(["Future 1", "Future 2", "Future 3", "Future 4", "Future 5"]);
    expect(stages[2]!.rows.map((row) => row.title)).toEqual(["Future 6", "Future 7", "Future 8", "Future 9", "Future 10"]);
  });

  it("returns three batches of five future lessons when nothing is live", () => {
    const rows = Array.from({ length: 16 }, (_, index) => ({
      title: `Future ${16 - index}`,
      status: "upcoming",
      scheduled_at: `2026-07-${String(26 - index).padStart(2, "0")}T10:00:00.000Z`
    }));
    const stages = selectLessonStages(rows);
    expect(stages.map((stage) => stage.rows.length)).toEqual([5, 5, 5]);
    expect(stages[0]!.rows[0]!.title).toBe("Future 1");
    expect(stages[2]!.rows[4]!.title).toBe("Future 15");
  });
});
