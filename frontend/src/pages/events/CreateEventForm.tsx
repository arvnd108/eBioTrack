// Owner: B (Frontend)
// Purpose: New collection event with its measurements and samples (POST /api/events)
//
// One request creates everything in one transaction; sample codes come back from the database.
// Only projects where the user may create events are offered (create_event_sample: an
// administrator, or a principal investigator or field researcher who is a non-viewer member),
// and only the sites linked to the chosen project (the API refuses others with 422).

import { useState, type FormEvent } from 'react';
import { FormField, fieldControlClass } from '../../components/common/FormField';
import { useAuth } from '../../hooks/useAuth';
import { useSampleTypes, useSiteIndex } from '../../hooks/useLookups';
import { useSubmit } from '../../hooks/useSubmit';
import { isApiError } from '../../services/apiClient';
import { errorMessage } from '../../services/errorMessages';
import { createEvent } from '../../services/eventsService';
import type { CollectionEventDetail, CreateEventRequest, Project } from '../../types';
import {
  MAX_MEASUREMENTS,
  MAX_SAMPLES,
  NOTES_MAX,
  checkCollectedAt,
  checkMeasurements,
  checkSample,
  hasErrors,
  localDateTimeToIso,
  newMeasurement,
  newSample,
  nowLocalInput,
  placeServerDetails,
  sampleBody,
  byKey,
  type MeasurementDraft,
  type MeasurementErrors,
  type SampleDraft,
  type SampleErrors,
} from './eventRules';
import { MeasurementRows, SampleRows } from './RowFields';
import { parseNumber } from '../../utils/format';

const TOP_FIELDS = ['project_id', 'site_id', 'collected_at', 'notes'] as const;
type TopField = (typeof TOP_FIELDS)[number];

interface CreateEventFormProps {
  projects: Project[];
  onCreated: (event: CollectionEventDetail) => void;
  onCancel: () => void;
}

const addClass =
  'rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50';

export function CreateEventForm({ projects, onCreated, onCancel }: CreateEventFormProps) {
  const { can } = useAuth();
  const writable = projects.filter((p) => can('create_event_sample', p.your_role));
  const [projectId, setProjectId] = useState(
    writable.length === 1 ? String(writable[0].project_id) : '',
  );
  const [siteId, setSiteId] = useState('');
  const [collectedAt, setCollectedAt] = useState(nowLocalInput());
  const [notes, setNotes] = useState('');
  const [measurements, setMeasurements] = useState<MeasurementDraft[]>([]);
  const [samples, setSamples] = useState<SampleDraft[]>([newSample('1')]);
  const [errors, setErrors] = useState<Partial<Record<TopField, string>>>({});
  // Row errors by row key, so removing a row keeps the others' messages on the right rows.
  const [measurementErrors, setMeasurementErrors] = useState<Record<number, MeasurementErrors>>({});
  const [sampleErrors, setSampleErrors] = useState<Record<number, SampleErrors>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const sites = useSiteIndex(projectId ? Number(projectId) : null, !!projectId);
  const types = useSampleTypes();
  const save = useSubmit(createEvent);
  const [serverShown, setServerShown] = useState(true);

  /** Editing a field clears its message (and the summary line) until the next save. */
  function edited(field?: TopField) {
    setFormError(null);
    setServerShown(false);
    if (field) setErrors(({ [field]: _cleared, ...rest }) => rest);
  }

  function editRows<R extends { key: number }, E>(
    next: R[],
    previous: R[],
    setRows: (rows: R[]) => void,
    setRowErrors: (update: (current: Record<number, E>) => Record<number, E>) => void,
  ) {
    const changed = new Set(next.filter((row) => !previous.includes(row)).map((row) => row.key));
    setRows(next);
    setRowErrors((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => !changed.has(Number(key)))),
    );
    edited();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const found: Partial<Record<TopField, string>> = {};
    if (!projectId) found.project_id = 'Choose the project.';
    if (!siteId) found.site_id = 'Choose the site.';
    const when = checkCollectedAt(collectedAt);
    if (when) found.collected_at = when;
    if (notes.trim().length > NOTES_MAX) found.notes = `At most ${NOTES_MAX} characters.`;
    const mErrors = checkMeasurements(measurements);
    const sErrors = samples.map(checkSample);
    setErrors(found);
    setMeasurementErrors(byKey(measurements, mErrors));
    setSampleErrors(byKey(samples, sErrors));
    if (hasErrors(found) || hasErrors(mErrors) || hasErrors(sErrors)) {
      setFormError('Check the highlighted fields.');
      return;
    }

    const body: CreateEventRequest = {
      project_id: Number(projectId),
      site_id: Number(siteId),
      collected_at: localDateTimeToIso(collectedAt)!,
      notes: notes.trim() || null,
      measurements: measurements.map((m) => ({
        parameter: m.parameter.trim(),
        value: parseNumber(m.value)!,
        unit: m.unit.trim(),
      })),
      samples: samples.map(sampleBody),
    };
    setServerShown(true);
    const created = await save.run(body);
    if (created) return onCreated(created);
  }

  // Server answers the checks above cannot know (site not linked, unknown sample type, 404/403).
  const server =
    serverShown && isApiError(save.error) ? placeServerDetails(save.error.details) : null;
  const topError = (field: TopField) => errors[field] ?? server?.top[field];
  const placed =
    !!server &&
    (TOP_FIELDS.some((f) => server.top[f]) ||
      Object.keys(server.measurements).length > 0 ||
      Object.keys(server.samples).length > 0);
  const serverFormError =
    save.error && serverShown
      ? placed
        ? 'Check the highlighted fields.'
        : errorMessage(save.error)
      : null;

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label="New collection event"
      className="space-y-5 rounded-lg border border-slate-200 bg-white p-4"
    >
      <div>
        <h2 className="text-lg font-semibold">New collection event</h2>
        <p className="text-sm text-slate-600">
          You are recorded as the collector. Sample codes are assigned when you save.
        </p>
      </div>

      {writable.length === 0 ? (
        <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          You are not a contributor on any project yet, so you cannot record events. A principal
          investigator can add you to a project.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label="Project" error={topError('project_id')} required>
          <select
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setSiteId('');
              edited('project_id');
            }}
            className={fieldControlClass(!!topError('project_id'))}
          >
            <option value="">Choose a project…</option>
            {writable.map((p) => (
              <option key={p.project_id} value={p.project_id}>
                {p.title}
              </option>
            ))}
          </select>
        </FormField>
        <FormField
          label="Site"
          error={topError('site_id')}
          hint={
            projectId && sites.status !== 'loading' && sites.list.length === 0
              ? 'This project has no sites yet. Link one on the project page first.'
              : undefined
          }
          required
        >
          <select
            value={siteId}
            onChange={(e) => {
              setSiteId(e.target.value);
              edited('site_id');
            }}
            disabled={!projectId}
            className={fieldControlClass(!!topError('site_id'))}
          >
            <option value="">{projectId ? 'Choose a site…' : 'Choose a project first'}</option>
            {sites.list.map((s) => (
              <option key={s.site_id} value={s.site_id}>
                {s.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField
          label="Collected at"
          error={topError('collected_at')}
          hint="Your local time."
          required
        >
          <input
            type="datetime-local"
            value={collectedAt}
            onChange={(e) => {
              setCollectedAt(e.target.value);
              edited('collected_at');
            }}
            className={fieldControlClass(!!topError('collected_at'))}
          />
        </FormField>
      </div>
      <FormField
        label="Notes"
        error={topError('notes')}
        hint="Optional. Weather, water colour, anything unusual."
      >
        <textarea
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value);
            edited('notes');
          }}
          rows={2}
          className={fieldControlClass(!!topError('notes'))}
        />
      </FormField>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-slate-800">
          Environmental measurements{' '}
          <span className="font-normal text-slate-500">({measurements.length})</span>
        </legend>
        <MeasurementRows
          rows={measurements}
          errors={measurements.map((row, i) => ({
            ...server?.measurements[i],
            ...measurementErrors[row.key],
          }))}
          onChange={(rows) => editRows(rows, measurements, setMeasurements, setMeasurementErrors)}
        />
        <button
          type="button"
          onClick={() => {
            setMeasurements([...measurements, newMeasurement()]);
            edited();
          }}
          disabled={measurements.length >= MAX_MEASUREMENTS}
          className={addClass}
        >
          Add measurement
        </button>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-slate-800">
          Samples <span className="font-normal text-slate-500">({samples.length})</span>
        </legend>
        <SampleRows
          rows={samples}
          errors={samples.map((row, i) => ({ ...server?.samples[i], ...sampleErrors[row.key] }))}
          types={types.list}
          onChange={(rows) => editRows(rows, samples, setSamples, setSampleErrors)}
        />
        <button
          type="button"
          onClick={() => {
            setSamples([...samples, newSample(samples.at(-1)?.sample_type_id ?? '1')]);
            edited();
          }}
          disabled={samples.length >= MAX_SAMPLES}
          className={addClass}
        >
          Add sample
        </button>
        {samples.length === 0 && (
          <p className="text-sm text-slate-600">
            No samples: the event is saved without any. You can add samples on its page later.
          </p>
        )}
      </fieldset>

      {(formError ?? serverFormError) && (
        <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-700">
          {formError ?? serverFormError}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={save.submitting || writable.length === 0}
          className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
        >
          {save.submitting ? 'Saving…' : 'Save event'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
