export function draftWithSuggestion(current: string, suggestion: string): string {
  const trimmed = current.trimEnd();
  if (!trimmed) return `${suggestion}\n`;
  return `${trimmed}\n\n${suggestion}\n`;
}
