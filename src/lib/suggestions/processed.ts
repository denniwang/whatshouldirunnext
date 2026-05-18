import type { EffortBucket, ProcessedActivity } from "./types";

export interface RawActivity {
  id: number;
  sport_type: string;
  type?: string;
  distance: number;
  moving_time: number;
  total_elevation_gain?: number | null;
  start_date: string | Date;
  start_date_local: string | Date;
}

const GAP_ELEV_ADJ_SEC_PER_M_PER_KM = 0.8;

function toDate(d: string | Date): Date {
  return d instanceof Date ? d : new Date(d);
}

function paceSecPerKm(movingTimeS: number, distanceM: number): number {
  if (distanceM <= 0) return 0;
  return movingTimeS / (distanceM / 1000);
}

function gradeAdjustedPace(
  paceSecPerKm: number,
  elevationGainM: number,
  distanceKm: number
): number {
  if (distanceKm <= 0 || paceSecPerKm <= 0) return paceSecPerKm;
  const elevPerKm = elevationGainM / distanceKm;
  return paceSecPerKm - elevPerKm * GAP_ELEV_ADJ_SEC_PER_M_PER_KM;
}

export function isRunLike(sport: string): boolean {
  return sport === "Run" || sport === "TrailRun" || sport === "VirtualRun";
}

export function processOne(raw: RawActivity): Omit<ProcessedActivity, "effort_score" | "effort_bucket"> {
  const distance_km = raw.distance / 1000;
  const elevation_gain_m = raw.total_elevation_gain ?? 0;
  const duration_min = raw.moving_time / 60;
  const pace_sec_per_km = paceSecPerKm(raw.moving_time, raw.distance);
  const grade_adjusted_pace = gradeAdjustedPace(pace_sec_per_km, elevation_gain_m, distance_km);
  return {
    id: raw.id,
    date: toDate(raw.start_date_local),
    type: raw.sport_type,
    duration_min,
    distance_km,
    elevation_gain_m,
    pace_sec_per_km,
    grade_adjusted_pace,
  };
}

function weightedPercentileRank(
  value: number,
  samples: { x: number; w: number }[]
): number {
  if (samples.length === 0) return 0.5;
  const sorted = [...samples].sort((a, b) => a.x - b.x);
  const total = sorted.reduce((s, p) => s + p.w, 0);
  if (total === 0) return 0.5;
  let cum = 0;
  for (const p of sorted) {
    if (p.x < value) cum += p.w;
    else if (p.x === value) cum += p.w / 2;
    else break;
  }
  return cum / total;
}

function bucketize(percentile: number): EffortBucket {
  if (percentile < 0.4) return "easy";
  if (percentile < 0.75) return "moderate";
  return "hard";
}

export function processActivities(raws: RawActivity[]): ProcessedActivity[] {
  const partials = raws.map(processOne);

  const runSamples = partials
    .filter((p) => isRunLike(p.type) && p.grade_adjusted_pace > 0 && p.distance_km >= 1)
    .map((p) => ({ x: p.grade_adjusted_pace, w: p.duration_min }));

  return partials
    .map((p) => {
      if (!isRunLike(p.type) || runSamples.length === 0 || p.grade_adjusted_pace <= 0) {
        return { ...p, effort_score: null, effort_bucket: "easy" as EffortBucket };
      }
      const inverse = 1 - weightedPercentileRank(p.grade_adjusted_pace, runSamples);
      const effort_score = Math.round(inverse * 100);
      return { ...p, effort_score, effort_bucket: bucketize(inverse) };
    })
    .sort((a, b) => b.date.getTime() - a.date.getTime());
}

export function filterToLastDays(
  processed: ProcessedActivity[],
  now: Date,
  days: number
): ProcessedActivity[] {
  const cutoff = now.getTime() - days * 86_400_000;
  return processed.filter((p) => p.date.getTime() >= cutoff);
}
