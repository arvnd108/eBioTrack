// Owner: B (Frontend)
// Purpose: Extraction batches: list, filter by lab, create (GET/POST /api/extraction-batches)
//
// A batch is one lab session (lab, date, kit); it belongs to no project, so creating one needs
// only the record_lab role (administrator, principal investigator, lab technician). The operator
// is the signed-in user.

import { useState, type FormEvent } from 'react';
import { DataTable, type Column } from '../../components/common/DataTable';
import { FormField, fieldControlClass } from '../../components/common/FormField';
import { useFetch } from '../../hooks/useFetch';
import { useLabAccess } from '../../hooks/useLabAccess';
import { useLabs, useUserNames } from '../../hooks/useLookups';
import { usePagination } from '../../hooks/usePagination';
import { useSubmit } from '../../hooks/useSubmit';
import { formErrors } from '../../services/errorMessages';
import { createBatch } from '../../services/labService';
import type { ExtractionBatch, PageMeta } from '../../types';
import { formatDate, todayLocal } from '../../utils/format';
import { KIT_MAX, NOTES_MAX, checkBatchDate, latestBatchDate } from './labRules';

const FIELDS = ['lab_id', 'extraction_date', 'kit_name', 'notes'] as const;
type Field = (typeof FIELDS)[number];

function BatchForm({
  onSaved,
  onCancel,
}: {
  onSaved: (batch: ExtractionBatch) => void;
  onCancel: () => void;
}) {
  const labs = useLabs();
  const [labId, setLabId] = useState('');
  const [date, setDate] = useState(todayLocal());
  const [kit, setKit] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const save = useSubmit(createBatch);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found: Partial<Record<Field, string>> = {};
    if (!labId) found.lab_id = 'Choose the lab.';
    const dateError = checkBatchDate(date);
    if (dateError) found.extraction_date = dateError;
    if (kit.trim().length > KIT_MAX) found.kit_name = `At most ${KIT_MAX} characters.`;
    if (notes.trim().length > NOTES_MAX) found.notes = `At most ${NOTES_MAX} characters.`;
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const saved = await save.run({
      lab_id: Number(labId),
      extraction_date: date,
      kit_name: kit.trim() || null,
      notes: notes.trim() || null,
    });
    if (saved) onSaved(saved);
  }

  const server = save.error ? formErrors(save.error, FIELDS) : { fieldErrors: {}, formError: null };
  const fieldError = (field: Field) => errors[field] ?? server.fieldErrors[field];
  const edit = (field: Field, set: (value: string) => void) => (value: string) => {
    set(value);
    setErrors(({ [field]: _cleared, ...rest }) => rest);
  };

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label="New extraction batch"
      className="space-y-4 rounded-lg border border-slate-200 bg-white p-4"
    >
      <div>
        <h3 className="text-base font-semibold">New extraction batch</h3>
        <p className="text-sm text-slate-600">You are recorded as the operator.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <FormField label="Lab" error={fieldError('lab_id')} required>
          <select
            value={labId}
            onChange={(e) => edit('lab_id', setLabId)(e.target.value)}
            className={fieldControlClass(!!fieldError('lab_id'))}
          >
            <option value="">Choose a lab…</option>
            {labs.list.map((l) => (
              <option key={l.lab_id} value={l.lab_id}>
                {l.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Extraction date" error={fieldError('extraction_date')} required>
          <input
            type="date"
            value={date}
            min="2000-01-01"
            max={latestBatchDate()}
            onChange={(e) => edit('extraction_date', setDate)(e.target.value)}
            className={fieldControlClass(!!fieldError('extraction_date'))}
          />
        </FormField>
        <FormField label="Kit" error={fieldError('kit_name')} hint="Optional.">
          <input
            value={kit}
            onChange={(e) => edit('kit_name', setKit)(e.target.value)}
            placeholder="DNeasy PowerWater Kit"
            className={fieldControlClass(!!fieldError('kit_name'))}
          />
        </FormField>
        <FormField label="Notes" error={fieldError('notes')} hint="Optional.">
          <input
            value={notes}
            onChange={(e) => edit('notes', setNotes)(e.target.value)}
            className={fieldControlClass(!!fieldError('notes'))}
          />
        </FormField>
      </div>
      {server.formError && (
        <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-700">
          {server.formError}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={save.submitting}
          className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
        >
          {save.submitting ? 'Saving…' : 'Create batch'}
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

interface BatchesSectionProps {
  /** Show only this batch's extractions below. */
  onShowExtractions: (batchId: number) => void;
}

export function BatchesSection({ onShowExtractions }: BatchesSectionProps) {
  const lab = useLabAccess();
  const labs = useLabs();
  const nameOf = useUserNames();
  const [labId, setLabId] = useState('');
  const [creating, setCreating] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const pager = usePagination({ initialSort: '-extraction_date' });
  const batches = useFetch<ExtractionBatch[], PageMeta>('/extraction-batches', {
    lab_id: labId || undefined,
    ...pager.query,
  });

  const columns: Column<ExtractionBatch>[] = [
    { key: 'batch_id', header: 'Batch', sortField: 'batch_id', render: (b) => `#${b.batch_id}` },
    {
      key: 'extraction_date',
      header: 'Date',
      sortField: 'extraction_date',
      render: (b) => formatDate(b.extraction_date),
    },
    {
      key: 'lab_id',
      header: 'Lab',
      render: (b) => labs.byId.get(b.lab_id)?.name ?? `Lab ${b.lab_id}`,
    },
    { key: 'kit_name', header: 'Kit' },
    {
      key: 'operator_id',
      header: 'Operator',
      render: (b) => nameOf(b.operator_id, b.operator_name),
    },
    { key: 'notes', header: 'Notes' },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (b) => (
        <button
          type="button"
          onClick={() => onShowExtractions(b.batch_id)}
          aria-label={`Show the extractions of batch ${b.batch_id}`}
          className="rounded-md border border-slate-300 px-2.5 py-1 text-sm text-slate-700 hover:bg-slate-100"
        >
          Extractions
        </button>
      ),
    },
  ];

  return (
    <section aria-labelledby="batches-heading" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-end gap-3">
          <h2 id="batches-heading" className="text-lg font-semibold">
            Extraction batches
          </h2>
          <div className="w-64">
            <FormField label="Lab">
              <select
                value={labId}
                onChange={(e) => {
                  setLabId(e.target.value);
                  pager.resetPage();
                }}
                className={fieldControlClass()}
              >
                <option value="">All labs</option>
                {labs.list.map((l) => (
                  <option key={l.lab_id} value={l.lab_id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
        </div>
        {lab.canCreateBatch && !creating && (
          <button
            type="button"
            onClick={() => {
              setSaved(null);
              setCreating(true);
            }}
            className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
          >
            New batch
          </button>
        )}
      </div>
      {saved && (
        <p role="status" className="rounded-md bg-emerald-50 p-2 text-sm text-emerald-800">
          {saved}
        </p>
      )}
      {creating && (
        <BatchForm
          onCancel={() => setCreating(false)}
          onSaved={(batch) => {
            setCreating(false);
            setSaved(`Created batch #${batch.batch_id}.`);
            batches.reload();
          }}
        />
      )}
      <DataTable
        caption="Extraction batches"
        columns={columns}
        rows={batches.data}
        rowKey={(b) => b.batch_id}
        loading={batches.status === 'loading'}
        error={batches.error}
        onRetry={batches.reload}
        sort={pager.sort}
        onSortChange={pager.setSort}
        pagination={batches.meta ? { meta: batches.meta, onPageChange: pager.setPage } : null}
        emptyTitle={labId ? 'No batches at this lab' : 'No extraction batches yet'}
      />
    </section>
  );
}
