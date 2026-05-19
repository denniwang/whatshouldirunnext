# whatshouldirunnext

Mobile-first website that connects to Strava and suggests 3 activities for today based on your last 90 days of training and your preferences. The dashboard also opens a modal with a paste-ready prompt for ChatGPT / Claude if you want a fuller 7-day plan.

Personal-use scope. Built on Next.js 15, Auth.js v5, Drizzle ORM, Neon Postgres.

## Setup

1. **Strava API app** — create at https://www.strava.com/settings/api. Set Authorization Callback Domain to `localhost` for dev.
2. **Neon DB** — create a project at https://neon.tech and copy the connection string.
3. **Env** — `cp .env.example .env.local` and fill in:
   - `DATABASE_URL` from Neon
   - `AUTH_SECRET` — generate with `openssl rand -base64 32`
   - `AUTH_STRAVA_ID`, `AUTH_STRAVA_SECRET` from your Strava app
4. **Install + push schema**:
   ```
   pnpm install
   pnpm db:push
   ```
5. **Run**:
   ```
   pnpm dev
   ```
   Open http://localhost:3000.

## Scripts

| | |
|---|---|
| `pnpm dev` | dev server |
| `pnpm build` | production build |
| `pnpm test` | vitest |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm db:push` | apply schema to `DATABASE_URL` |
| `pnpm db:studio` | Drizzle studio |

## How suggestions work

Pure rule-based, no AI calls. The pipeline:

1. Cached Strava rows → `processActivities` adds GAP (grade-adjusted pace) and a weighted-percentile effort bucket (`easy` / `moderate` / `hard`).
2. `computeAthleteState` derives 7d/28d load, ACWR (acute:chronic workload ratio), days since last run, longest 28d run, typical flat/hilly pace, and "days since last tempo/intervals/long-run."
3. `generateSuggestions` picks a mode:
   - **Onboarding** (`prefs.onboarded === false`, or <5 lifetime activities, or <25 km lifetime distance): 3 canned easy sessions to start.
   - **Returning** (no run in the last 14 days): 3 conservative sessions to ease back.
   - **Race day** (`goal = race` and `race_date` is today): a single shake-out/rest card.
   - **Normal**: runs the rule set below, dedupes by type, pads up to 3 with fillers. Lower-priority candidates surface as **alternatives** in a collapsed disclosure.

Rules (normal mode):

- **Recovery override** — triggers on (a) yesterday's run was >90 min or `hard` bucket, (b) ACWR > 1.5 with enough load, or (c) the "bothering" injury chip is set. When it fires, all other rules are skipped.
- **Long run** — fires on your configured long-run day (ISO weekday) with a 5-day guard, or as a catch-up later in the same ISO week if the preferred day already passed and no long run has been logged. Targets ~10% over your longest 28d run.
- **Race-quality (tempo)** — `goal = race`: tempo tuned to race distance (5k/10k/half/marathon/ultra). Skipped if yesterday was hard.
- **Intervals** — `goal = race` and `race_distance` is 5k or 10k: structured reps × distance with jog recovery, sized from your 28-day weekly average. Skipped during race week. Shares priority 2 with tempo; older session-type wins (ties favor intervals).
- **Easy default** — adaptive duration (clamped 30–50 min) at conversational pace. Reason text adapts to whether you're flushing legs, behind on volume, or just doing base work. Emits longer/shorter/strides/trail variants for the alternatives surface.
- **Cross-train / rest** — adds a cross-train if you already ran today; adds a rest day if `volume_preference = recover` and you're near your 28d weekly average.

In a race taper window the engine scales `duration_min` on running suggestions (and `suggested_weekly_target_min`) by a distance-aware scalar — marathon/ultra 14d (0.80 → 0.60), half 10d (0.85 → 0.65), 10k 7d (1.00 → 0.75), 5k 5d (1.00 → 0.70). Pace is never reduced.

The engine returns at most 3 suggestions (priorities 1/2/3) plus up to 8 alternatives. The "Get an AI plan from these prefs" button on the dashboard opens a modal with a structured prompt (preferences + training state + recent sessions + today's 3 deterministic suggestions + alternatives) — paste into ChatGPT or Claude for a 7-day plan.

## Deploy to Vercel

1. Push to a GitHub repo, import into Vercel.
2. Connect Neon integration (auto-creates branch DB per preview).
3. Add env vars (set `AUTH_TRUST_HOST=true`).
4. Update Strava app callback domain to your Vercel domain.

## Powered by Strava

Activity data is read from your Strava account via the official API. The app never modifies your data and never posts on your behalf. The Disconnect button on the Preferences page deauthorizes the app and deletes all stored data.
