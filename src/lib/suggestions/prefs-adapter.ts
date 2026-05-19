import type { Preferences } from "@/db/schema";
import type { PreferencesInput, VolumePreference } from "./types";

export function adaptDbPrefs(row: Preferences): PreferencesInput {
  const daysAvailable = [1, 2, 3, 4, 5, 6, 7].filter(
    (d) => !row.restDays.includes(d)
  );

  const volumePreference: VolumePreference =
    row.intensityPref === "easy"
      ? "recover"
      : row.intensityPref === "hard"
      ? "build"
      : "maintain";

  return {
    goal: "general_fitness",
    race_distance: null,
    race_date: null,
    days_available: daysAvailable.length > 0 ? daysAvailable : [1, 2, 3, 4, 5, 6],
    long_run_day: row.longSessionDay,
    bothering: [],
    notes: row.notes,
    volume_preference: volumePreference,
    onboarded: true,
  };
}
