/** Keeps provider credentials and request internals out of API and log output. */
export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, "[redacted endpoint]")
    .replace(/\b(wss?:\/\/)[^\s"'<>]+/gi, "[redacted endpoint]")
    .replace(/([?&](?:api[_-]?key|token|secret|password)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 300);
}
