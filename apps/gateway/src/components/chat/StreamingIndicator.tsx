/** Immediate feedback while a submitted assistant turn has not produced visible text yet. */
export function StreamingIndicator() {
  return (
    <div className="flex items-center gap-2 py-1 text-muted-foreground text-sm" role="status" aria-live="polite">
      <span className="flex items-center gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1.5 animate-typing-dot rounded-full bg-current"
            style={{ animationDelay: `${i * 0.18}s` }}
          />
        ))}
      </span>
      <span>Working…</span>
    </div>
  );
}
