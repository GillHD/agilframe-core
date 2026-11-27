/**
 * Filename sanitisation for untrusted user input (uploads, exports, reports).
 *
 * - keeps only the basename (strips POSIX and Windows path separators);
 * - removes control characters and NUL bytes;
 * - caps the result at 180 characters;
 * - rejects the `.` / `..` names;
 * - falls back to `file` when nothing safe is left.
 */
export const MAX_FILENAME_LENGTH = 180;

/** Sanitises an untrusted file name. Never throws; always returns a non-empty name. */
export function sanitizeFilename(name: string): string {
  const raw = typeof name === 'string' ? name : '';
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') return 'file';
  const capped = cleaned.slice(0, MAX_FILENAME_LENGTH).trim();
  if (capped.length === 0 || capped === '.' || capped === '..') return 'file';
  return capped;
}
