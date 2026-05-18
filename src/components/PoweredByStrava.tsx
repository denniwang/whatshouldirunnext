export function PoweredByStrava() {
  return (
    <div className="flex items-center justify-center gap-2 py-4 text-xs text-[var(--muted)]">
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
        <path
          fill="#fc4c02"
          d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.599h4.172L10.207 0l-7 13.828h4.172"
        />
      </svg>
      <span>Powered by Strava</span>
    </div>
  );
}
