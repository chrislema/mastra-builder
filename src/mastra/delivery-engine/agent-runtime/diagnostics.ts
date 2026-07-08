export function compactDiagnostic(error: unknown, limit = 600) {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > limit ? `${text.slice(0, limit)}... (${text.length} chars total)` : text;
}
