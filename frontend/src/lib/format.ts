/** Shared formatting. Small, and shared because two screens show sizes. */

/** `412 MB`, `1.2 GB` — matched to how the design writes sizes. */
export function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${bytes} B`;
}

/**
 * `3 minutes ago`, `2 days ago`, or a date once that stops being useful.
 *
 * Seconds since the epoch, which is what the server sends for a file's
 * mtime — not milliseconds.
 */
export function formatWhen(epochSeconds: number): string {
  if (!epochSeconds) return 'unknown';
  const seconds = Math.max(0, Date.now() / 1000 - epochSeconds);
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  if (days <= 10) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  return new Date(epochSeconds * 1000).toLocaleDateString();
}
