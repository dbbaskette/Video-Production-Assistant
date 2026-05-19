/**
 * Extract the first ```json fenced block from `text` and JSON.parse it.
 * Returns null if no block is present or the JSON is malformed.
 */
export function parseJsonBlock<T = unknown>(text: string): T | null {
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m || !m[1]) return null;
  try {
    return JSON.parse(m[1].trim()) as T;
  } catch {
    return null;
  }
}
