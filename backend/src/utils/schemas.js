// Owner: A (Backend)
// Purpose: Shared zod building blocks for route validation (ids, dates, pagination query keys)
import { z } from 'zod';

/** A positive integer id from a URL or query string ("12"); rejects "1e3", "0", "-1", "abc". */
export const idString = z
  .string()
  .regex(/^[1-9]\d{0,14}$/, 'must be a positive integer')
  .transform(Number);

/** A positive integer id inside a JSON body (a number, not a string). */
export const idNumber = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** `YYYY-MM-DD` that is a real calendar date (rejects 2025-02-30). */
export const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date as YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'must be a real calendar date');

/** Query keys that `pagination()` reads; kept so validate() does not strip them. */
export const pageQuery = {
  page: z.string().optional(),
  limit: z.string().optional(),
  sort: z.string().optional(),
};

/** `true` / `false` query flag. */
export const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

/** At least one key must be present (PATCH bodies). */
export const atLeastOneKey = (value) => Object.keys(value).length > 0;
