"use client";
import { signIn } from "next-auth/react";

export function ConnectStravaButton() {
  return (
    <button
      onClick={() => signIn("strava", { callbackUrl: "/dashboard" })}
      className="inline-flex items-center justify-center gap-3 rounded-lg bg-strava px-6 py-4 text-white font-semibold shadow hover:bg-strava-dark active:scale-[0.98] transition"
      style={{ minHeight: 48 }}
      aria-label="Connect with Strava"
    >
      <StravaLogo />
      <span>Connect with Strava</span>
    </button>
  );
}

function StravaLogo() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
      <path
        fill="currentColor"
        d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.599h4.172L10.207 0l-7 13.828h4.172"
      />
    </svg>
  );
}
