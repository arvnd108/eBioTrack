// Owner: B (Frontend)
// Purpose: Display formatting for dates, timestamps and enum values
//
// D20: timestamps are stored in UTC and shown in the browser's local time. Calendar dates
// (`YYYY-MM-DD`, for example a project's start date) have no time zone and are shown as written,
// never shifted by one day.

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

const DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** `2025-01-15` -> "15 Jan 2025" (in the user's locale); empty -> "—". */
export function formatDate(date: string | null | undefined): string {
  if (!date) return '—';
  const parsed = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : DATE_FORMAT.format(parsed);
}

/** An ISO timestamp in the user's local time, "29 Oct 2026, 14:05"; empty -> "—". */
export function formatDateTime(timestamp: string | null | undefined): string {
  if (!timestamp) return '—';
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? timestamp : DATE_TIME_FORMAT.format(parsed);
}

/** `principal_investigator` -> "Principal investigator", `project_members` -> "Project members". */
export function humanize(value: string): string {
  const words = value.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Today's date in the user's time zone, `YYYY-MM-DD` (for date input limits). */
export function todayLocal(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A number typed in a text box ("7.4", "-0.5", "1e3"), or null when it is not one. */
export function parseNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)(e[-+]?\d+)?$/i.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}
