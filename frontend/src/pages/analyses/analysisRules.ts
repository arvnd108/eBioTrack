// Owner: B (Frontend)
// Purpose: Analysis form checks, with the API's limits (backend routes/analyses.routes.js)
//
//   - a run and a marker; pipeline name and reference database 1-200 characters, pipeline
//     version and reference database version 1-100 (the version is optional);
//   - parameters: optional, a JSON object, at most 10 000 characters as JSON;
//   - reject: a reason, 1-1000 characters.
// The API checks all of this again; these give plain messages before anything is sent.

export const PIPELINE_NAME_MAX = 200;
export const PIPELINE_VERSION_MAX = 100;
export const REFERENCE_DB_MAX = 200;
export const REFERENCE_DB_VERSION_MAX = 100;
export const PARAMETERS_MAX = 10000;
export const REASON_MAX = 1000;

/** Common choices offered in the form (any text is accepted). */
export const PIPELINES = ['OBITools3', 'QIIME 2', 'DADA2', 'Anacapa', 'MetaWorks'];
export const REFERENCE_DBS = ['MitoFish', 'BOLD Systems', 'NCBI GenBank', 'MIDORI2', 'SILVA'];

/** The parameters box: empty sends nothing; otherwise a JSON object within the size limit. */
export function parseParameters(
  text: string,
): { value: Record<string, unknown> | undefined } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { error: 'Enter valid JSON, for example {"min_length": 100}.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'Enter a JSON object in curly braces, for example {"min_length": 100}.' };
  }
  if (JSON.stringify(parsed).length > PARAMETERS_MAX) {
    return { error: 'At most 10 000 characters.' };
  }
  return { value: parsed as Record<string, unknown> };
}

/** A required text field: blank or too long gives the message, otherwise undefined. */
export function checkRequiredText(value: string, what: string, max: number): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return `Enter the ${what}.`;
  if (trimmed.length > max) return `At most ${max} characters.`;
  return undefined;
}

/** A header and two example rows, for the "Download a template" link (CONTRACT 12). */
export function templateCsv(libraryCodes: readonly string[]): string {
  const [first = 'LIB-0001', second = first] = libraryCodes;
  return [
    'library_code,scientific_name,taxon_rank,read_count,confidence,qc_flag',
    `${first},Labeo rohita,species,14250,0.9712,pass`,
    `${second},Labeo,genus,720,0.7410,warn`,
    '',
  ].join('\r\n');
}

/** "1.2 MB", "340 KB", "12 bytes". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} byte${bytes === 1 ? '' : 's'}`;
}
