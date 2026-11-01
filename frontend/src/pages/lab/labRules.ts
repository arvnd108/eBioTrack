// Owner: B (Frontend)
// Purpose: Lab form checks, with the API's limits (backend routes/extractions|sequencing.routes.js)
//
//   - batch: a lab; an extraction date from 2000-01-01 to tomorrow (UTC, as the API counts);
//     kit name 1-200 characters when given; notes up to 2000;
//   - extraction: concentration_ng_ul 0..9999999.999 (numeric(10,3)), purity_a260_280 0..999.99
//     (numeric(5,2)), both optional;
//   - QC result: a sample or an analysis, a type and a result; any number as metric; notes <= 2000;
//   - run: a lab, platform 1-100 characters, a real run date, 1-500 distinct extractions.
// The API checks all of this again; these give plain messages before anything is sent.

import { isCalendarDate } from '../projects/projectRules';
import { parseNumber } from '../../utils/format';

export const KIT_MAX = 200;
export const NOTES_MAX = 2000;
export const PLATFORM_MAX = 100;
export const MAX_EXTRACTIONS_PER_RUN = 500;
export const EARLIEST_BATCH_DATE = '2000-01-01';

/** Tomorrow as the API counts it (UTC), `YYYY-MM-DD`. */
export const latestBatchDate = (now = Date.now()) =>
  new Date(now + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

export function checkBatchDate(value: string, now = Date.now()): string | undefined {
  if (!value) return 'Enter the extraction date.';
  if (!isCalendarDate(value)) return 'Enter a real date.';
  if (value < EARLIEST_BATCH_DATE || value > latestBatchDate(now)) {
    return 'The date must be between 1 Jan 2000 and tomorrow.';
  }
  return undefined;
}

/** An optional measurement typed in a text box: '' is "not measured". */
export function checkMeasurement(
  text: string,
  max: number,
): { value: number | null; error?: string } {
  if (!text.trim()) return { value: null };
  const value = parseNumber(text);
  if (value === null) return { value: null, error: 'Enter a number.' };
  if (value < 0) return { value, error: 'Must be 0 or more.' };
  if (value > max) return { value, error: `Must be at most ${max}.` };
  return { value };
}

export const CONCENTRATION_MAX = 9999999.999;
export const PURITY_MAX = 999.99;

/** Common sequencing platforms, offered as suggestions (the field is free text). */
export const PLATFORMS = [
  'Illumina MiSeq',
  'Illumina NextSeq 2000',
  'Illumina NovaSeq 6000',
  'Oxford Nanopore MinION',
  'Oxford Nanopore GridION',
  'Ion Torrent S5',
];
