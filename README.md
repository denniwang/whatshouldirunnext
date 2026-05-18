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
2. `computeAthleteState` derives 7d/28d load, ACWR (acute:chronic workload ratio), days since last run, longest 28d run, typical flat/hilly pace.
3. `generateSuggestions` picks a mode:
   - **Onboarding** (oldest activity <14 days old): 3 canned easy sessions to start.
   - **Returning** (no run in last 14 days): 3 conservative sessions to ease back.
   - **Normal**: runs the rule set below, dedupes by type, pads up to 3 with fillers.

Rules (normal mode):

- **Recovery override** — triggers on (a) yesterday's run was >90 min or `hard` bucket, (b) ACWR > 1.5 with enough load, or (c) the "bothering" injury chip is set. When it fires, all other rules are skipped.
- **Long run** — fires only on your configured long-run day (ISO weekday). Targets ~10% over your longest 28d run.
- **Race-quality** — `goal = race`: tempo/intervals tuned to race distance (5k/10k/half/marathon/ultra). Skipped if yesterday was hard or you're inside a 14-day taper window.
- **Easy default** — adaptive duration (clamped 25–55 min) at conversational pace. Reason text adapts to whether you're flushing legs, behind on volume, or just doing base work.
- **Cross-train / rest** — adds a cross-train if you already ran today; adds a rest day if `volume_preference = recover` and you're near your 28d weekly average.

The engine returns at most 3 suggestions (priorities 1/2/3). The "Get an AI plan from these prefs" button on the dashboard opens a modal with a structured prompt (preferences + training state + recent sessions + today's 3 deterministic suggestions) — paste into ChatGPT or Claude for a 7-day plan.

## Deploy to Vercel

1. Push to a GitHub repo, import into Vercel.
2. Connect Neon integration (auto-creates branch DB per preview).
3. Add env vars (set `AUTH_TRUST_HOST=true`).
4. Update Strava app callback domain to your Vercel domain.

## Powered by Strava

Activity data is read from your Strava account via the official API. The app never modifies your data and never posts on your behalf. The Disconnect button on the Preferences page deauthorizes the app and deletes all stored data.
