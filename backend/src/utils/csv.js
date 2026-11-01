// Owner: A (Backend)
// Purpose: CSV parsing and validation for analysis import; CSV export
//
// Import (CONTRACT 12). parseCsv is a one-pass RFC 4180 parser: quoted fields may hold commas,
// doubled quotes and line breaks; CRLF, LF and CR end a record; an optional UTF-8 BOM is dropped.
// Records are numbered from 1 with the header as record 1 (so the first data record is row 2);
// completely empty records are skipped but still counted, so row numbers keep pointing at the
// record the user sees. validateDetectionRecords checks the FORMAT of every record and collects
// all errors; lookups against the database (taxa, libraries, repeats) happen in the service.
//
// Export. csvLine / csvCell write RFC 4180 with CRLF line ends and no BOM. A text cell that starts
// with = + - @ TAB or CR is prefixed with an apostrophe so a spreadsheet cannot run it as a
// formula; numbers are written as they are.

export const IMPORT_COLUMNS = Object.freeze([
  'library_code',
  'scientific_name',
  'taxon_rank',
  'read_count',
  'confidence',
  'qc_flag',
]);
export const TAXON_RANKS = Object.freeze([
  'domain',
  'kingdom',
  'phylum',
  'class',
  'order',
  'family',
  'genus',
  'species',
]);
export const QC_FLAGS = Object.freeze(['pass', 'warn', 'fail']);

const MAX_READ_COUNT = 2147483647;

export class CsvFormatError extends Error {}

/**
 * Parse CSV text into records (arrays of strings).
 * @param {string} text
 * @returns {{ row: number, fields: string[] }[]} non-empty records with their 1-based record number
 * @throws {CsvFormatError} for an unterminated quote or text after a closing quote
 */
export function parseCsv(text) {
  let source = text;
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  const records = [];
  let fields = [];
  let field = '';
  let inQuotes = false;
  let afterQuote = false; // just closed a quoted field: only , or a line end may follow
  let recordNumber = 1;
  let started = false; // the current record has any character

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

  const length = source.length;
  for (let i = 0; i < length; i += 1) {
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

/**
 * Check the header record. Returns the column index of each expected column, or errors (one per
 * missing, unexpected or repeated column, each naming the field).
 * @param {string[]} header
 */
export function checkHeader(header) {
  const names = header.map((name) => name.trim());
  const errors = [];
  const index = {};
  names.forEach((name, i) => {
    if (!IMPORT_COLUMNS.includes(name)) {
      errors.push({ row: 1, field: name || '(blank)', message: 'unexpected column' });
    } else if (name in index) {
      errors.push({ row: 1, field: name, message: 'column appears more than once' });
    } else {
      index[name] = i;
    }
  });
  for (const name of IMPORT_COLUMNS) {
    if (!(name in index)) errors.push({ row: 1, field: name, message: 'column is missing' });
  }
  return { index, errors };
}

const INTEGER = /^\d+$/;
const DECIMAL = /^\d+(\.\d+)?$/;

/**
 * Format-check the data records. Every error is collected, in file order.
 * @param {{ row: number, fields: string[] }[]} dataRecords
 * @param {Record<string, number>} index column positions from checkHeader
 * @returns {{ rows: object[], errors: { row: number, field: string, message: string }[] }}
 *   rows: records without a format error, parsed (read_count and confidence are numbers)
 */
export function validateDetectionRecords(dataRecords, index) {
  const errors = [];
  const rows = [];
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
    const get = (name) => fields[index[name]].trim();
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
    if (!TAXON_RANKS.includes(rank)) {
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
    if (!QC_FLAGS.includes(qcFlag)) {
      errors.push({ row, field: 'qc_flag', message: 'must be one of pass, warn, fail' });
    }
    if (errors.length === before) {
      rows.push({
        row,
        library_code: libraryCode,
        scientific_name: scientificName,
        taxon_rank: rank,
        read_count: Number(readCount),
        confidence: Number(confidence),
        qc_flag: qcFlag,
      });
    }
  }
  return { rows, errors };
}

// Export ----------------------------------------------------------------------------------------

const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** One cell: null becomes empty, Dates ISO, numbers as they are, text neutralised and quoted. */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One record, with its CRLF line end. */
export function csvLine(values) {
  return `${values.map(csvCell).join(',')}\r\n`;
}
