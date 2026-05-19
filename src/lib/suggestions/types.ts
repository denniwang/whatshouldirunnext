export type EffortBucket = "easy" | "moderate" | "hard";

export type SportType =
  | "Run"
  | "TrailRun"
  | "Ride"
  | "VirtualRide"
  | "Walk"
  | "Hike"
  | "Swim"
  | "WeightTraining"
  | "Yoga"
  | "Workout"
  | (string & {});

export interface ProcessedActivity {
  id: number;
  date: Date;
  type: SportType;
  duration_min: number;
  distance_km: number;
  elevation_gain_m: number;
  pace_sec_per_km: number;
  grade_adjusted_pace: number;
  effort_score: number | null;
  effort_bucket: EffortBucket;
}

export interface AthleteState {
  load_7d_min: number;
  load_28d_min: number;
  load_28d_weekly_avg: number;
  acwr: number;
  days_since_last_run: number;
  longest_run_28d_min: number;
  longest_run_28d_km: number;
  typical_pace_flat: number | null;
  typical_pace_hilly: number | null;
  last_3_activities: ProcessedActivity[];
  recent_runs: ProcessedActivity[];
  hours_since_last_activity: number | null;
  total_runs_in_window: number;
  total_activities_in_window: number;
  oldest_activity_date: Date | null;
  suggested_weekly_target_min: number;
  days_since_last_quality_session: number;
  days_since_last_tempo: number;
  days_since_last_intervals: number;
  days_since_last_long_run: number;
}

export type Goal =
  | "general_fitness"
  | "race"
  | "weight_loss"
  | "returning_from_break";

export type RaceDistance = "5k" | "10k" | "half" | "marathon" | "ultra";

export type VolumePreference = "recover" | "maintain" | "build";

export type BotheringChip =
  | "knee"
  | "hip"
  | "ankle"
  | "foot"
  | "calf"
  | "hamstring"
  | "lower_back"
  | "none";

export interface PreferencesInput {
  goal: Goal;
  race_distance: RaceDistance | null;
  race_date: Date | null;
  days_available: number[];
  long_run_day: number | null;
  bothering: BotheringChip[];
  notes: string | null;
  volume_preference: VolumePreference;
  onboarded: boolean;
}

export type WorkoutType =
  | "easy"
  | "long"
  | "tempo"
  | "intervals"
  | "recovery"
  | "rest"
  | "cross-train";

export interface PaceRange {
  low: number;
  high: number;
}

export interface WorkoutSuggestion {
  type: WorkoutType;
  duration_min: number;
  distance_km_estimate: number;
  pace_range: PaceRange | null;
  pace_note?: string;
  terrain: "flat" | "rolling" | "hilly" | "any";
  reason: string;
  priority: number;
  for_when?: "today" | "tomorrow";
  warmup_min?: number;
  cooldown_min?: number;
  repetitions?: number;
  rep_distance_m?: number;
  rep_duration_s?: number;
  recovery_duration_s?: number;
  recovery_type?: "jog" | "walk";
  suggestion_id?: string;
}
