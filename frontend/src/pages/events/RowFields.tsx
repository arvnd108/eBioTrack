// Owner: B (Frontend)
// Purpose: Editable rows for an event's measurements and samples
//
// Each row is a line of inputs under shared column headings; every input has its own accessible
// name ("Parameter, row 2") and shows its error underneath.

import { useId, type ReactNode } from 'react';
import { fieldControlClass } from '../../components/common/FormField';
import { STANDARD_PARAMETERS } from '../../domain';
import type { SampleType } from '../../types';
import { humanize } from '../../utils/format';
import type { MeasurementDraft, MeasurementErrors, SampleDraft, SampleErrors } from './eventRules';

function Cell({
  error,
  children,
}: {
  error?: string;
  children: (describedBy?: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div>
      {children(error ? id : undefined)}
      {error && (
        <p id={id} className="mt-1 text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

const removeClass =
  'rounded-md px-2 py-2 text-sm text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50';

interface MeasurementRowsProps {
  rows: MeasurementDraft[];
  errors: MeasurementErrors[];
  onChange: (rows: MeasurementDraft[]) => void;
}

export function MeasurementRows({ rows, errors, onChange }: MeasurementRowsProps) {
  const listId = useId();
  const update = (index: number, change: Partial<MeasurementDraft>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...change } : row)));

  if (rows.length === 0) return null;
  return (
    <div className="space-y-2">
      <datalist id={listId}>
        {STANDARD_PARAMETERS.map((p) => (
          <option key={p.parameter} value={p.parameter}>
            {p.label}
          </option>
        ))}
      </datalist>
      <div
        aria-hidden="true"
        className="hidden grid-cols-[1fr_8rem_8rem_auto] gap-2 text-xs font-medium uppercase tracking-wide text-slate-500 sm:grid"
      >
        <span>Parameter</span>
        <span>Value</span>
        <span>Unit</span>
        <span className="w-16" />
      </div>
      {rows.map((row, index) => {
        const e = errors[index] ?? {};
        const n = index + 1;
        return (
          <div key={row.key} className="grid gap-2 sm:grid-cols-[1fr_8rem_8rem_auto]">
            <Cell error={e.parameter}>
              {(describedBy) => (
                <input
                  aria-label={`Parameter, row ${n}`}
                  aria-invalid={!!e.parameter || undefined}
                  aria-describedby={describedBy}
                  list={listId}
                  value={row.parameter}
                  placeholder="ph"
                  onChange={(event) => {
                    const parameter = event.target.value;
                    const standard = STANDARD_PARAMETERS.find(
                      (p) => p.parameter === parameter.trim(),
                    );
                    // A standard parameter brings its unit, unless one was typed already.
                    update(
                      index,
                      standard && !row.unit ? { parameter, unit: standard.unit } : { parameter },
                    );
                  }}
                  className={fieldControlClass(!!e.parameter)}
                />
              )}
            </Cell>
            <Cell error={e.value}>
              {(describedBy) => (
                <input
                  aria-label={`Value, row ${n}`}
                  aria-invalid={!!e.value || undefined}
                  aria-describedby={describedBy}
                  inputMode="decimal"
                  value={row.value}
                  onChange={(event) => update(index, { value: event.target.value })}
                  className={fieldControlClass(!!e.value)}
                />
              )}
            </Cell>
            <Cell error={e.unit}>
              {(describedBy) => (
                <input
                  aria-label={`Unit, row ${n}`}
                  aria-invalid={!!e.unit || undefined}
                  aria-describedby={describedBy}
                  value={row.unit}
                  onChange={(event) => update(index, { unit: event.target.value })}
                  className={fieldControlClass(!!e.unit)}
                />
              )}
            </Cell>
            <button
              type="button"
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
              aria-label={`Remove measurement ${n}`}
              className={`${removeClass} w-16`}
            >
              Remove
            </button>
          </div>
        );
      })}
    </div>
  );
}

interface SampleFieldsProps {
  row: SampleDraft;
  errors: SampleErrors;
  types: SampleType[];
  /** Added to each accessible name, for example ", sample 2"; empty for a single sample. */
  suffix?: string;
  onChange: (row: SampleDraft) => void;
  remove?: ReactNode;
}

/** One sample's inputs: type, volume (mL), depth (m), storage location. */
export function SampleFields({
  row,
  errors: e,
  types,
  suffix = '',
  onChange,
  remove,
}: SampleFieldsProps) {
  const update = (change: Partial<SampleDraft>) => onChange({ ...row, ...change });
  return (
    <div className="grid gap-2 sm:grid-cols-[10rem_8rem_8rem_1fr_auto]">
      <Cell error={e.sample_type_id}>
        {(describedBy) => (
          <select
            aria-label={`Sample type${suffix}`}
            aria-invalid={!!e.sample_type_id || undefined}
            aria-describedby={describedBy}
            value={row.sample_type_id}
            onChange={(event) => update({ sample_type_id: event.target.value })}
            className={fieldControlClass(!!e.sample_type_id)}
          >
            <option value="">Type…</option>
            {types.map((t) => (
              <option key={t.sample_type_id} value={t.sample_type_id}>
                {humanize(t.type_name)}
              </option>
            ))}
          </select>
        )}
      </Cell>
      <Cell error={e.volume_ml}>
        {(describedBy) => (
          <input
            aria-label={`Volume (mL)${suffix}`}
            aria-invalid={!!e.volume_ml || undefined}
            aria-describedby={describedBy}
            inputMode="decimal"
            placeholder="mL"
            value={row.volume_ml}
            onChange={(event) => update({ volume_ml: event.target.value })}
            className={fieldControlClass(!!e.volume_ml)}
          />
        )}
      </Cell>
      <Cell error={e.depth_m}>
        {(describedBy) => (
          <input
            aria-label={`Depth (m)${suffix}`}
            aria-invalid={!!e.depth_m || undefined}
            aria-describedby={describedBy}
            inputMode="decimal"
            placeholder="m"
            value={row.depth_m}
            onChange={(event) => update({ depth_m: event.target.value })}
            className={fieldControlClass(!!e.depth_m)}
          />
        )}
      </Cell>
      <Cell error={e.storage_location}>
        {(describedBy) => (
          <input
            aria-label={`Storage location${suffix}`}
            aria-invalid={!!e.storage_location || undefined}
            aria-describedby={describedBy}
            placeholder="Freezer A-1"
            value={row.storage_location}
            onChange={(event) => update({ storage_location: event.target.value })}
            className={fieldControlClass(!!e.storage_location)}
          />
        )}
      </Cell>
      {remove}
    </div>
  );
}

interface SampleRowsProps {
  rows: SampleDraft[];
  errors: SampleErrors[];
  types: SampleType[];
  onChange: (rows: SampleDraft[]) => void;
}

export function SampleRows({ rows, errors, types, onChange }: SampleRowsProps) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-2">
      <div
        aria-hidden="true"
        className="hidden grid-cols-[10rem_8rem_8rem_1fr_auto] gap-2 text-xs font-medium uppercase tracking-wide text-slate-500 sm:grid"
      >
        <span>Type</span>
        <span>Volume (mL)</span>
        <span>Depth (m)</span>
        <span>Storage location</span>
        <span className="w-16" />
      </div>
      {rows.map((row, index) => (
        <SampleFields
          key={row.key}
          row={row}
          errors={errors[index] ?? {}}
          types={types}
          suffix={`, sample ${index + 1}`}
          onChange={(next) => onChange(rows.map((r, i) => (i === index ? next : r)))}
          remove={
            <button
              type="button"
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
              aria-label={`Remove sample ${index + 1}`}
              className={`${removeClass} w-16`}
            >
              Remove
            </button>
          }
        />
      ))}
    </div>
  );
}
