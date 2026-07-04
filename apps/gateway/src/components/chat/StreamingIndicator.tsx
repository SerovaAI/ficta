/** Three-dot pulse shown while the assistant turn is streaming but has produced no visible text yet. */
export function StreamingIndicator() {
  return (
    <div className="flex items-center gap-1 py-1" role="status" aria-label="Assistant is typing">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-typing-dot rounded-full bg-muted-foreground/70"
          style={{ animationDelay: `${i * 0.18}s` }}
        />
      ))}
    </div>
  );
}
