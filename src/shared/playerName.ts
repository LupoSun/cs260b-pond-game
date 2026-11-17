/** Maximum nickname length, counted in Unicode code points (engineering default). */
export const PLAYER_NAME_MAX_LENGTH = 16;

/**
 * Normalizes a participant-typed nickname for display on phones, the classroom
 * screen, and Mission Control. Returns null when nothing usable remains.
 */
export function sanitizePlayerName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .normalize('NFKC')
    // Control, zero-width, and bidi-override characters would break or spoof the display
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, PLAYER_NAME_MAX_LENGTH).join('').trim() || null;
}
