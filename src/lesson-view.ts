export interface LessonStage {
  kind: "live" | "upcoming";
  scheduledAt: string | null;
  rows: Record<string, unknown>[];
}

export function selectLessonStages(
  rows: Record<string, unknown>[],
  maximumStages = 3
): LessonStage[] {
  if (maximumStages <= 0) return [];
  const stages: LessonStage[] = [];
  const liveRows = rows.filter((row) => row.status === "live");
  if (liveRows.length) {
    stages.push({ kind: "live", scheduledAt: null, rows: liveRows });
  }

  const upcoming = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    if (row.status === "live") continue;
    const scheduledAt = String(row.scheduled_at || "");
    if (!scheduledAt) continue;
    const group = upcoming.get(scheduledAt) || [];
    group.push(row);
    upcoming.set(scheduledAt, group);
  }
  const ordered = [...upcoming.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [scheduledAt, stageRows] of ordered) {
    if (stages.length >= maximumStages) break;
    stages.push({ kind: "upcoming", scheduledAt, rows: stageRows });
  }
  return stages;
}
