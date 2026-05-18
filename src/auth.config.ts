import type { NextAuthConfig } from "next-auth";
import Strava from "next-auth/providers/strava";
import { env } from "@/env";

export const authConfig = {
  providers: [
    Strava({
      clientId: env.AUTH_STRAVA_ID,
      clientSecret: env.AUTH_STRAVA_SECRET,
      authorization: {
        params: {
          scope: "read,activity:read_all",
          approval_prompt: "auto",
        },
      },
    }),
  ],
  callbacks: {
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
  pages: {
    signIn: "/",
  },
} satisfies NextAuthConfig;
