// Owner: B (Frontend)
// Purpose: Detection CSV format (CONTRACT 12): parse, check the header and rows, write CSV lines
//
// A line-for-line port of backend/src/utils/csv.js, so the import page can check a file before
// uploading it and the mock API answers a dry run exactly like the real one (same row numbers,
// fields and messages). parseCsv is RFC 4180: quoted fields may hold commas, doubled quotes and
// line breaks; CRLF, LF and CR end a record; a UTF-8 BOM is dropped. Records are numbered from 1
// with the header as record 1; empty records are skipped but still counted, so row numbers point
// at the line the user sees in a spreadsheet. Keep this file in step with csv.js.

import { TAXON_RANKS as DOMAIN_TAXON_RANKS } from '../domain';
import type { QcFlag, TaxonRank } from '../types';

export const IMPORT_COLUMNS = [
  'library_code',
  'scientific_name',
  'taxon_rank',
  'read_count',
  'confidence',
  'qc_flag',
] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

export const TAXON_RANKS: readonly TaxonRank[] = DOMAIN_TAXON_RANKS;
export const QC_FLAGS: readonly QcFlag[] = ['pass', 'warn', 'fail'];

/** CONTRACT 12 and the upload limit of POST /api/analyses/import (413 above it). */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const MAX_READ_COUNT = 2147483647;

export interface CsvRecord {
  row: number;
  fields: string[];
}

export interface CsvRowError {
  row: number;
  field: string;
  message: string;
}

export interface DetectionCsvRow {
  row: number;
  library_code: string;
  scientific_name: string;
  taxon_rank: TaxonRank;
  read_count: number;
  confidence: number;
  qc_flag: QcFlag;
}

export class CsvFormatError extends Error {}

/** Records with their 1-based record number; throws CsvFormatError for broken quoting. */
export function parseCsv(text: string): CsvRecord[] {
  let source = text;
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let afterQuote = false;
  let recordNumber = 1;
  let started = false;

  const endField = () => {
    fields.push(field);
    field = '';
    afterQuote = false;
  };
  const endRecord = () => {
    endField();
    const blank = fields.length === 1 && fields[0] === '' && !started;
    if (!blank) records.push({ row: recordNumber, fields });
    fields = [];
    started = false;
    recordNumber += 1;
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === ',') {
      started = true;
      endField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      endRecord();
    } else if (afterQuote) {
      throw new CsvFormatError(`row ${recordNumber}: unexpected text after a closing quote`);
    } else if (ch === '"' && field === '') {
      started = true;
      inQuotes = true;
    } else {
      started = true;
      field += ch;
    }
  }
  if (inQuotes) throw new CsvFormatError(`row ${recordNumber}: a quoted field is not closed`);
  if (started || field !== '' || fields.length > 0) endRecord();
  return records;
}

/** Column positions, or one error per missing, unexpected or repeated column (row 1). */
export function checkHeader(header: string[]): {
  index: Partial<Record<ImportColumn, number>>;
  errors: CsvRowError[];
} {
  const names = header.map((name) => name.trim());
  const errors: CsvRowError[] = [];
  const index: Partial<Record<ImportColumn, number>> = {};
  names.forEach((name, i) => {
    if (!(IMPORT_COLUMNS as readonly string[]).includes(name)) {
      errors.push({ row: 1, field: name || '(blank)', message: 'unexpected column' });
    } else if (name in index) {
      errors.push({ row: 1, field: name, message: 'column appears more than once' });
    } else {
      index[name as ImportColumn] = i;
    }
  });
  for (const name of IMPORT_COLUMNS) {
    if (!(name in index)) errors.push({ row: 1, field: name, message: 'column is missing' });
  }
  return { index, errors };
}

const INTEGER = /^\d+$/;
const DECIMAL = /^\d+(\.\d+)?$/;

/** Format-check the data records; every error is collected, in file order. */
export function validateDetectionRecords(
  dataRecords: CsvRecord[],
  index: Partial<Record<ImportColumn, number>>,
): { rows: DetectionCsvRow[]; errors: CsvRowError[] } {
  const errors: CsvRowError[] = [];
  const rows: DetectionCsvRow[] = [];
  for (const { row, fields } of dataRecords) {
    if (fields.length !== IMPORT_COLUMNS.length) {
      errors.push({
        row,
        field: 'row',
        message: `expected ${IMPORT_COLUMNS.length} fields, found ${fields.length}`,
      });
      continue;
    }
    const before = errors.length;
    const get = (name: ImportColumn) => fields[index[name]!].trim();
    const libraryCode = get('library_code');
    const scientificName = get('scientific_name');
    const rank = get('taxon_rank');
    const readCount = get('read_count');
    const confidence = get('confidence');
    const qcFlag = get('qc_flag');

    if (libraryCode === '') errors.push({ row, field: 'library_code', message: 'is required' });
    if (scientificName === '') {
      errors.push({ row, field: 'scientific_name', message: 'is required' });
    }
    if (!(TAXON_RANKS as readonly string[]).includes(rank)) {
      errors.push({
        row,
        field: 'taxon_rank',
        message: `must be one of ${TAXON_RANKS.join(', ')}`,
      });
    }
    if (!INTEGER.test(readCount) || Number(readCount) > MAX_READ_COUNT) {
      errors.push({
        row,
        field: 'read_count',
        message: `must be a whole number from 0 to ${MAX_READ_COUNT}`,
      });
    }
    if (!DECIMAL.test(confidence) || Number(confidence) > 1) {
      errors.push({ row, field: 'confidence', message: 'must be a number between 0 and 1' });
    }
    if (!(QC_FLAGS as readonly string[]).includes(qcFlag)) {
      errors.push({ row, field: 'qc_flag', message: 'must be one of pass, warn, fail' });
    }
    if (errors.length === before) {
      rows.push({
        row,
        library_code: libraryCode,
        scientific_name: scientificName,
        taxon_rank: rank as TaxonRank,
        read_count: Number(readCount),
        confidence: Number(confidence),
        qc_flag: qcFlag as QcFlag,
      });
    }
  }
  return { rows, errors };
}

/**
 * Everything that can be checked without the database, the way the API checks it: the file must
 * be UTF-8 CSV with data rows, the header must name exactly the six columns, every row must have
 * valid values. `fileProblem` is a whole-file error (the API's 422 "The file is not a valid CSV");
 * otherwise `errors` lists row problems and `rows` the rows that passed (library codes and taxon
 * names are still checked by the server).
 */
export function checkDetectionCsv(text: string): {
  fileProblem: string | null;
  rows: DetectionCsvRow[];
  errors: CsvRowError[];
} {
  if (text.trim() === '') return { fileProblem: 'the file is empty', rows: [], errors: [] };
  let records: CsvRecord[];
  try {
    records = parseCsv(text);
  } catch (err) {
    if (err instanceof CsvFormatError) return { fileProblem: err.message, rows: [], errors: [] };
    throw err;
  }
  const { index, errors: headerErrors } = checkHeader(records[0].fields);
  if (headerErrors.length > 0) return { fileProblem: null, rows: [], errors: headerErrors };
  const data = records.slice(1);
  if (data.length === 0) {
    return {
      fileProblem: null,
      rows: [],
      errors: [{ row: 1, field: 'file', message: 'the file has no data rows' }],
    };
  }
  const checked = validateDetectionRecords(data, index);
  return { fileProblem: null, ...checked };
}

// Export ------------------------------------------------------------------------------------

const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** One cell: null is empty, numbers as they are, text neutralised (formula prefix) and quoted. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One record with its CRLF line end. */
export function csvLine(values: unknown[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}
