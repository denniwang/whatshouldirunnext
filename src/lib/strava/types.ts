import { z } from "zod";

export const summaryActivitySchema = z.object({
  id: z.number(),
  name: z.string().optional().nullable(),
  sport_type: z.string(),
  type: z.string().optional(),
  distance: z.number(),
  moving_time: z.number().int(),
  elapsed_time: z.number().int(),
  total_elevation_gain: z.number().nullable().optional(),
  average_heartrate: z.number().nullable().optional(),
  average_watts: z.number().nullable().optional(),
  start_date: z.string(),
  start_date_local: z.string(),
  timezone: z.string().nullable().optional(),
  trainer: z.boolean().optional().default(false),
  commute: z.boolean().optional().default(false),
  private: z.boolean().optional().default(false),
});

export type SummaryActivity = z.infer<typeof summaryActivitySchema>;

export const tokenResponseSchema = z.object({
  token_type: z.string(),
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: z.number().int(),
  expires_in: z.number().int(),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;
