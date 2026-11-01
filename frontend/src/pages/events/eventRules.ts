// Owner: B (Frontend)
// Purpose: Collection event and sample form checks, with the API's limits
//
// From backend routes/events.routes.js and routes/samples.routes.js (T21), checked again by the
// API and the database:
//   - collected_at: required, at most one day in the future;
//   - notes: at most 5000 characters;
//   - measurements: at most 50; parameter (1-100 characters, once per event), value (a number),
//     unit (1-50 characters);
//   - samples: at most 100; a sample type; volume_ml > 0 (numeric(10,2)); depth_m >= 0
//     (numeric(8,2)); storage_location 1-200 characters when given.

import type { NewSampleFields } from '../../types';
import { parseNumber } from '../../utils/format';

export const NOTES_MAX = 5000;
export const MAX_MEASUREMENTS = 50;
export const MAX_SAMPLES = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface MeasurementDraft {
  key: number;
  parameter: string;
  value: string;
  unit: string;
}

export interface SampleDraft {
  key: number;
  sample_type_id: string;
  volume_ml: string;
  depth_m: string;
  storage_location: string;
}

export type RowErrors<F extends string> = Partial<Record<F, string>>;
export type MeasurementErrors = RowErrors<'parameter' | 'value' | 'unit'>;
export type SampleErrors = RowErrors<
  'sample_type_id' | 'volume_ml' | 'depth_m' | 'storage_location'
>;

let nextKey = 1;
export const newMeasurement = (parameter = '', unit = ''): MeasurementDraft => ({
  key: nextKey++,
  parameter,
  value: '',
  unit,
});
export const newSample = (sampleTypeId = ''): SampleDraft => ({
  key: nextKey++,
  sample_type_id: sampleTypeId,
  volume_ml: '',
  depth_m: '',
  storage_location: '',
});

/** `datetime-local` value ("2026-03-12T09:30", the user's time) -> ISO instant, or null. */
export function localDateTimeToIso(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1, 6).map(Number);
  const parsed = new Date(year, month - 1, day, hour, minute, Number(m[6] ?? 0));
  // Date rolls 30 February over into March; a real date keeps its own day and month.
  if (parsed.getMonth() !== month - 1 || parsed.getDate() !== day || hour > 23 || minute > 59) {
    return null;
  }
  return parsed.toISOString();
}

/** Now in the user's time, as a `datetime-local` value (minutes). */
export function nowLocalInput(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}`;
}

export function checkCollectedAt(value: string, now = Date.now()): string | undefined {
  if (!value) return 'Enter when the samples were collected.';
  const iso = localDateTimeToIso(value);
  if (!iso) return 'Enter a real date and time.';
  if (Date.parse(iso) > now + DAY_MS) return 'Must not be more than one day in the future.';
  return undefined;
}

export function checkMeasurements(rows: MeasurementDraft[]): MeasurementErrors[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const errors: MeasurementErrors = {};
    const parameter = row.parameter.trim();
    if (!parameter) errors.parameter = 'Enter the parameter.';
    else if (parameter.length > 100) errors.parameter = 'At most 100 characters.';
    else if (seen.has(parameter)) errors.parameter = 'This parameter is already in the list.';
    seen.add(parameter);
    if (!row.value.trim()) errors.value = 'Enter the value.';
    else if (parseNumber(row.value) === null) errors.value = 'Enter a number.';
    const unit = row.unit.trim();
    if (!unit) errors.unit = 'Enter the unit.';
    else if (unit.length > 50) errors.unit = 'At most 50 characters.';
    return errors;
  });
}

export function checkSample(row: SampleDraft): SampleErrors {
  const errors: SampleErrors = {};
  if (!row.sample_type_id) errors.sample_type_id = 'Choose the sample type.';
  if (row.volume_ml.trim()) {
    const volume = parseNumber(row.volume_ml);
    if (volume === null) errors.volume_ml = 'Enter a number.';
    else if (volume <= 0) errors.volume_ml = 'Must be greater than 0.';
    else if (volume > 99999999.99) errors.volume_ml = 'Too large.';
  }
  if (row.depth_m.trim()) {
    const depth = parseNumber(row.depth_m);
    if (depth === null) errors.depth_m = 'Enter a number.';
    else if (depth < 0) errors.depth_m = 'Must be 0 or more.';
    else if (depth > 999999.99) errors.depth_m = 'Too large.';
  }
  if (row.storage_location.trim().length > 200) errors.storage_location = 'At most 200 characters.';
  return errors;
}

/** The API body for one sample row (empty optional fields are left out). */
export function sampleBody(row: SampleDraft): NewSampleFields {
  const body: NewSampleFields = { sample_type_id: Number(row.sample_type_id) };
  if (row.volume_ml.trim()) body.volume_ml = parseNumber(row.volume_ml);
  if (row.depth_m.trim()) body.depth_m = parseNumber(row.depth_m);
  if (row.storage_location.trim()) body.storage_location = row.storage_location.trim();
  return body;
}

/** Errors listed by row position -> errors by row key (rows without errors are left out). */
export function byKey<E extends object>(rows: { key: number }[], errors: E[]): Record<number, E> {
  return Object.fromEntries(
    rows.flatMap((row, i) => (Object.keys(errors[i] ?? {}).length ? [[row.key, errors[i]]] : [])),
  );
}

export const hasErrors = (errors: object | object[]): boolean =>
  Array.isArray(errors)
    ? errors.some((e) => Object.keys(e).length > 0)
    : Object.keys(errors).length > 0;

/**
 * Places the API's 422 details on rows: `measurements[1].parameter` -> row 1, field parameter.
 * Returns the messages for top-level fields too.
 */
export function placeServerDetails(details: { field?: string; message: string }[]) {
  const top: Record<string, string> = {};
  const measurements: Record<number, MeasurementErrors> = {};
  const samples: Record<number, SampleErrors> = {};
  for (const { field, message } of details) {
    if (!field) continue;
    const row = /^(measurements|samples)\[(\d+)\]\.(\w+)$/.exec(field);
    if (row) {
      const target = row[1] === 'measurements' ? measurements : samples;
      const index = Number(row[2]);
      target[index] = { ...target[index], [row[3]]: message };
    } else if (!top[field]) {
      top[field] = message;
    }
  }
  return { top, measurements, samples };
}
