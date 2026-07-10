export interface LessonStage {
  kind: "live" | "upcoming";
  rows: Record<string, unknown>[];
}

export function selectLessonStages(
  rows: Record<string, unknown>[],
  positionsPerStage = 5,
  maximumStages = 3
): LessonStage[] {
  if (maximumStages <= 0 || positionsPerStage <= 0) return [];
  const stages: LessonStage[] = [];
  const liveRows = rows.filter((row) => row.status === "live").slice(0, positionsPerStage);
  if (liveRows.length) {
    stages.push({ kind: "live", rows: liveRows });
  }

  const upcoming = rows
    .filter((row) => row.status !== "live" && row.scheduled_at)
    .sort((left, right) => String(left.scheduled_at).localeCompare(String(right.scheduled_at)));
  for (let offset = 0; offset < upcoming.length; offset += positionsPerStage) {
    if (stages.length >= maximumStages) break;
    stages.push({ kind: "upcoming", rows: upcoming.slice(offset, offset + positionsPerStage) });
  }
  return stages;
}
