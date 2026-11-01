// Owner: A (Backend)
// Purpose: CSV parser, import format checks and export serialiser (no database needed)
import { describe, expect, it } from 'vitest';
import {
  CsvFormatError,
  checkHeader,
  csvCell,
  csvLine,
  parseCsv,
  validateDetectionRecords,
} from '../src/utils/csv.js';

const HEADER = 'library_code,scientific_name,taxon_rank,read_count,confidence,qc_flag';
const validate = (line) => {
  const records = parseCsv(`${HEADER}\n${line}`);
  const { index } = checkHeader(records[0].fields);
  return validateDetectionRecords(records.slice(1), index);
};

describe('parseCsv', () => {
  it('handles BOM, CRLF, quoted commas, quotes and line breaks, blank lines', () => {
    const records = parseCsv('﻿a,b\r\n"x,""y""\nz",2\r\n\r\n3,4\r\n');
    expect(records).toEqual([
      { row: 1, fields: ['a', 'b'] },
      { row: 2, fields: ['x,"y"\nz', '2'] },
      { row: 4, fields: ['3', '4'] },
    ]);
  });
  it('keeps empty fields and a record without a final line end', () => {
    expect(parseCsv('a,,c\n,,')).toEqual([
      { row: 1, fields: ['a', '', 'c'] },
      { row: 2, fields: ['', '', ''] },
    ]);
  });
  it('rejects an unterminated quote and text after a closing quote', () => {
    expect(() => parseCsv('a,"b\n1,2')).toThrow(CsvFormatError);
    expect(() => parseCsv('"a"x,b')).toThrow(CsvFormatError);
  });
});

describe('checkHeader', () => {
  it('accepts the six columns in any order', () => {
    const { index, errors } = checkHeader([
      'qc_flag',
      'confidence',
      'read_count',
      'taxon_rank',
      'scientific_name',
      'library_code',
    ]);
    expect(errors).toEqual([]);
    expect(index.library_code).toBe(5);
  });
  it('names missing, extra and repeated columns', () => {
    const { errors } = checkHeader(['library_code', 'library_code', 'extra', 'qc_flag']);
    const text = errors.map((e) => `${e.field}:${e.message}`);
    expect(text).toContain('library_code:column appears more than once');
    expect(text).toContain('extra:unexpected column');
    expect(text).toContain('scientific_name:column is missing');
  });
});

describe('validateDetectionRecords', () => {
  it('accepts a good row as numbers', () => {
    const { rows, errors } = validate('LIB-0001,Labeo rohita,species,14250,0.9712,pass');
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ row: 2, read_count: 14250, confidence: 0.9712 });
  });
  it.each([
    ['read_count', 'LIB-1,A b,species,12.5,0.5,pass'],
    ['read_count', 'LIB-1,A b,species,1e3,0.5,pass'],
    ['read_count', 'LIB-1,A b,species,"14,250",0.5,pass'],
    ['read_count', 'LIB-1,A b,species,,0.5,pass'],
    ['read_count', 'LIB-1,A b,species,-1,0.5,pass'],
    ['confidence', 'LIB-1,A b,species,1,1.5,pass'],
    ['confidence', 'LIB-1,A b,species,1,abc,pass'],
    ['qc_flag', 'LIB-1,A b,species,1,0.5,PASS'],
    ['taxon_rank', 'LIB-1,A b,Species,1,0.5,pass'],
    ['library_code', ' ,A b,species,1,0.5,pass'],
    ['scientific_name', 'LIB-1, ,species,1,0.5,pass'],
  ])('flags %s in %s', (field, line) => {
    const { errors } = validate(line);
    expect(errors.map((e) => e.field)).toEqual([field]);
    expect(errors[0].row).toBe(2);
  });
  it('collects every error of a row and of later rows, in file order', () => {
    const { errors } = validate('LIB-1,A b,bad,x,2,no\nLIB-2,C d,species,1,0.5');
    expect(errors.map((e) => `${e.row}:${e.field}`)).toEqual([
      '2:taxon_rank',
      '2:read_count',
      '2:confidence',
      '2:qc_flag',
      '3:row',
    ]);
  });
});

describe('csvCell and csvLine', () => {
  it.each([
    ['=1+1', "'=1+1"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@cmd', "'@cmd"],
    ['\tx', "'\tx"],
    ['\rx', '"\'\rx"'],
    ['plain', 'plain'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['two\nlines', '"two\nlines"'],
  ])('writes %j as %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });
  it('leaves numbers alone, empties null, writes dates as ISO', () => {
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(0.9731)).toBe('0.9731');
    expect(csvCell(null)).toBe('');
    expect(csvCell(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
  });
  it('ends records with CRLF and round-trips through the parser', () => {
    const line = csvLine(['a,b', '=x', 3, null, 'q"r']);
    expect(line.endsWith('\r\n')).toBe(true);
    expect(parseCsv(line)[0].fields).toEqual(['a,b', "'=x", '3', '', 'q"r']);
  });
});
