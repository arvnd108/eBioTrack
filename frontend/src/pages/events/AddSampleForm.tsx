// Owner: B (Frontend)
// Purpose: Register one more sample on an existing event (POST /api/samples)
//
// The database numbers the code within the event (register_sample()). Allowed for
// create_event_sample in the event's project.

import { useState, type FormEvent } from 'react';
import { useSampleTypes } from '../../hooks/useLookups';
import { useSubmit } from '../../hooks/useSubmit';
import { isApiError } from '../../services/apiClient';
import { errorMessage } from '../../services/errorMessages';
import { createSample } from '../../services/samplesService';
import { checkSample, hasErrors, newSample, sampleBody, type SampleErrors } from './eventRules';
import { SampleFields } from './RowFields';

interface AddSampleFormProps {
  eventId: number;
  onAdded: (sampleCode: string) => void;
}

export function AddSampleForm({ eventId, onAdded }: AddSampleFormProps) {
  const types = useSampleTypes();
  const [row, setRow] = useState(() => newSample('1'));
  const [errors, setErrors] = useState<SampleErrors>({});
  const save = useSubmit(createSample);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found = checkSample(row);
    setErrors(found);
    if (hasErrors(found)) return;
    const created = await save.run({ event_id: eventId, ...sampleBody(row) });
    if (created) {
      setRow(newSample(row.sample_type_id));
      onAdded(created.sample_code);
    }
  }

  // 422 details name the body fields directly (volume_ml, depth_m, ...).
  const serverErrors: SampleErrors = {};
  if (isApiError(save.error)) {
    for (const d of save.error.details) {
      if (d.field && d.field in row) serverErrors[d.field as keyof SampleErrors] = d.message;
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label="Add sample"
      className="space-y-2 rounded-lg border border-slate-200 bg-white p-4"
    >
      <h3 className="text-sm font-semibold text-slate-800">Add a sample to this event</h3>
      <SampleFields
        row={row}
        errors={{ ...serverErrors, ...errors }}
        types={types.list}
        onChange={(next) => {
          setRow(next);
          setErrors({});
          save.reset();
        }}
        remove={
          <button
            type="submit"
            disabled={save.submitting}
            className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
          >
            {save.submitting ? 'Adding…' : 'Add sample'}
          </button>
        }
      />
      {save.error && Object.keys(serverErrors).length === 0 ? (
        <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-700">
          {errorMessage(save.error)}
        </p>
      ) : null}
    </form>
  );
}
