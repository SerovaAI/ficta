export const THREAD_TITLE_MAX = 80;

const DEFAULT_THREAD_TITLE = "New chat";
const ATTACHED_TEXT_FILE_TITLE = "Review Attached Text File";
const USER_REQUEST_LABEL = "User request:";
const USER_REQUEST_MARKER = `\n\n${USER_REQUEST_LABEL}\n`;
const FILE_CONTENT_CLOSE = "</file_content>";

export function deriveThreadTitleFromText(text: string | undefined): string {
  if (!text) return DEFAULT_THREAD_TITLE;

  const requestTitle = titleFromUserRequest(text);
  if (requestTitle) return requestTitle;

  if (hasAttachedTextFileContext(text)) return ATTACHED_TEXT_FILE_TITLE;

  return normalizeTitle(text) || DEFAULT_THREAD_TITLE;
}

function titleFromUserRequest(text: string): string | undefined {
  const markerIndex = text.lastIndexOf(USER_REQUEST_MARKER);
  if (markerIndex === -1) return undefined;

  const lastFileContentClose = text.lastIndexOf(FILE_CONTENT_CLOSE);
  if (lastFileContentClose !== -1 && markerIndex < lastFileContentClose) return undefined;

  const requestText = text.slice(markerIndex + USER_REQUEST_MARKER.length);
  return normalizeTitle(requestText) || undefined;
}

function hasAttachedTextFileContext(text: string): boolean {
  return /(?:^|\n)Attached text file \d+ \(filename omitted for privacy, [^)]+\):\s*\n<file_content>/u.test(text);
}

function normalizeTitle(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, THREAD_TITLE_MAX);
}
