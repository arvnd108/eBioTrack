// Owner: B (Frontend)
// Purpose: Change a sample's status (PATCH /api/samples/:id/status)
//
// Offers only the next statuses CONTRACT section 3 allows from the current one; the API checks
// again (409 invalid_transition, for example when someone else changed it first). Allowed for
// change_sample_status: administrator, or a principal investigator, field researcher or lab
// technician who is a non-viewer member of the sample's project.

import { useState, type FormEvent } from 'react';
import { FormField, fieldControlClass } from '../../components/common/FormField';
import { SAMPLE_TRANSITIONS } from '../../domain';
import { useSubmit } from '../../hooks/useSubmit';
import { isApiError } from '../../services/apiClient';
import { errorMessage } from '../../services/errorMessages';
import { changeSampleStatus } from '../../services/samplesService';
import type { SampleStatus } from '../../types';
import { humanize } from '../../utils/format';

interface StatusChangeFormProps {
  sampleId: number;
  status: SampleStatus;
  onChanged: () => void;
}

/** Statuses after which nothing else is allowed (or only discarding). */
const FINAL_WARNING: Partial<Record<SampleStatus, string>> = {
  discarded: 'Discarded is final: the sample cannot change status again.',
  failed: 'A failed sample can only be discarded afterwards.',
  analyzed: 'Analyzed is final: the sample cannot change status again.',
};

export function StatusChangeForm({ sampleId, status, onChanged }: StatusChangeFormProps) {
  const options = SAMPLE_TRANSITIONS[status];
  const [next, setNext] = useState<SampleStatus | ''>('');
  const [choiceError, setChoiceError] = useState<string | null>(null);
  const save = useSubmit(async (id: number, newStatus: SampleStatus) => {
    try {
      return await changeSampleStatus(id, newStatus);
    } catch (err) {
      // 409: the sample changed since the page loaded; show its current status.
      if (isApiError(err) && err.code === 'invalid_transition') {
        setNext('');
        onChanged();
      }
      throw err;
    }
  });

  const errorText = !save.error
    ? null
    : isApiError(save.error) && save.error.code === 'invalid_transition'
      ? `${save.error.message}. The sample may have changed since this page loaded; it now shows the current status.`
      : errorMessage(save.error);
  const errorBox = errorText ? (
    <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-700">
      {errorText}
    </p>
  ) : null;

  if (options.length === 0) {
    return (
      <div className="space-y-2">
        {errorBox}
        <p className="text-sm text-slate-600">
          {humanize(status)} is a final status, so it cannot be changed.
        </p>
      </div>
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!next) {
      setChoiceError('Choose the new status.');
      return;
    }
    setChoiceError(null);
    if (await save.run(sampleId, next)) {
      setNext('');
      onChanged();
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label="Change status"
      className="space-y-3 rounded-lg border border-slate-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-56">
          <FormField label="New status" error={choiceError} required>
            <select
              value={next}
              onChange={(e) => setNext(e.target.value as SampleStatus | '')}
              className={fieldControlClass(!!choiceError)}
            >
              <option value="">Choose…</option>
              {options.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <button
          type="submit"
          disabled={save.submitting}
          className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
        >
          {save.submitting ? 'Saving…' : 'Change status'}
        </button>
      </div>
      {next && FINAL_WARNING[next] && (
        <p className="text-sm text-amber-800">{FINAL_WARNING[next]}</p>
      )}
      {errorBox}
    </form>
  );
}
