// Owner: B (Frontend)
// Purpose: Create or edit a sampling site (POST /api/sites, PATCH /api/sites/:id)
//
// For manage_sites (administrator, principal investigator, field researcher). Limits from the
// API (backend routes/sites.routes.js): name 1-200 characters and unique within its region,
// latitude -90..90 and longitude -180..180 (stored with 6 decimals), a habitat type, and an
// optional description up to 2000 characters. Coordinates can be typed or picked on the map.
// Editing is allowed even when events already use the site; only changed fields are sent.

import { useState, type FormEvent } from 'react';
import { FormField, fieldControlClass } from '../../components/common/FormField';
import { HABITAT_TYPES } from '../../domain';
import { useSubmit } from '../../hooks/useSubmit';
import { formErrors } from '../../services/errorMessages';
import { createSite, updateSite, type SiteFields } from '../../services/sitesService';
import type { HabitatType, Region, Site } from '../../types';
import { humanize, parseNumber } from '../../utils/format';

const FIELDS = [
  'region_id',
  'name',
  'latitude',
  'longitude',
  'habitat_type',
  'description',
] as const;
type Field = (typeof FIELDS)[number];

interface SiteFormProps {
  regions: Region[];
  /** The site being edited; leave out to create one. */
  site?: Site;
  /** Coordinates picked on the map, applied when they change. */
  picked: { latitude: number; longitude: number } | null;
  onSaved: (site: Site) => void;
  onCancel: () => void;
}

export function SiteForm({ regions, site, picked, onSaved, onCancel }: SiteFormProps) {
  const editing = !!site;
  const [name, setName] = useState(site?.name ?? '');
  const [regionId, setRegionId] = useState(site ? String(site.region_id) : '');
  const [habitat, setHabitat] = useState<HabitatType | ''>(site?.habitat_type ?? '');
  const [latitude, setLatitude] = useState(site ? String(site.latitude) : '');
  const [longitude, setLongitude] = useState(site ? String(site.longitude) : '');
  const [description, setDescription] = useState(site?.description ?? '');
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [note, setNote] = useState<string | null>(null);
  const [lastPick, setLastPick] = useState(picked);
  const save = useSubmit((body: Partial<SiteFields>) =>
    site ? updateSite(site.site_id, body) : createSite(body as SiteFields),
  );

  // A new click on the map fills the coordinates (adjusting state while rendering, as React
  // recommends for props that should reset state).
  if (picked && picked !== lastPick) {
    setLastPick(picked);
    setLatitude(String(picked.latitude));
    setLongitude(String(picked.longitude));
    setErrors(({ latitude: _lat, longitude: _lng, ...rest }) => rest);
  }

  function check(): Partial<Record<Field, string>> {
    const found: Partial<Record<Field, string>> = {};
    const trimmed = name.trim();
    if (!trimmed) found.name = 'Enter the site name.';
    else if (trimmed.length > 200) found.name = 'At most 200 characters.';
    if (!regionId) found.region_id = 'Choose the region.';
    if (!habitat) found.habitat_type = 'Choose the habitat.';
    const lat = parseNumber(latitude);
    if (lat === null) found.latitude = 'Enter a number, or click the map.';
    else if (lat < -90 || lat > 90) found.latitude = 'Latitude must be between -90 and 90.';
    const lng = parseNumber(longitude);
    if (lng === null) found.longitude = 'Enter a number, or click the map.';
    else if (lng < -180 || lng > 180) found.longitude = 'Longitude must be between -180 and 180.';
    if (description.trim().length > 2000) found.description = 'At most 2000 characters.';
    return found;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNote(null);
    const found = check();
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const values: SiteFields = {
      region_id: Number(regionId),
      name: name.trim(),
      latitude: parseNumber(latitude)!,
      longitude: parseNumber(longitude)!,
      habitat_type: habitat as HabitatType,
      description: description.trim() || null,
    };
    let body: Partial<SiteFields> = values;
    if (site) {
      body = Object.fromEntries(
        (Object.keys(values) as (keyof SiteFields)[])
          .filter((key) => values[key] !== site[key])
          .map((key) => [key, values[key]]),
      );
      if (Object.keys(body).length === 0) {
        setNote('Nothing has changed.');
        return;
      }
    }
    const saved = await save.run(body);
    if (saved) onSaved(saved);
  }

  const server = save.error
    ? formErrors(save.error, FIELDS, {
        duplicate: { field: 'name', message: 'This region already has a site with this name.' },
        invalid_reference: { field: 'region_id', message: 'This region no longer exists.' },
      })
    : { fieldErrors: {}, formError: null };
  const fieldError = (field: Field) => errors[field] ?? server.fieldErrors[field];
  /** Editing a field clears its message until the next save. */
  const edit = (field: Field, set: (value: string) => void) => (value: string) => {
    set(value);
    setErrors(({ [field]: _cleared, ...rest }) => rest);
    setNote(null);
    save.reset();
  };

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label={editing ? `Edit ${site.name}` : 'New site'}
      className="space-y-4 rounded-lg border border-slate-200 bg-white p-4"
    >
      <div>
        <h2 className="text-lg font-semibold">{editing ? `Edit ${site.name}` : 'New site'}</h2>
        <p className="text-sm text-slate-600">
          Click the map to set the coordinates, or type them.
          {editing && ' Changes apply to every project and event that uses this site.'}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Name" error={fieldError('name')} required>
          <input
            value={name}
            onChange={(e) => edit('name', setName)(e.target.value)}
            className={fieldControlClass(!!fieldError('name'))}
          />
        </FormField>
        <FormField label="Region" error={fieldError('region_id')} required>
          <select
            value={regionId}
            onChange={(e) => edit('region_id', setRegionId)(e.target.value)}
            className={fieldControlClass(!!fieldError('region_id'))}
          >
            <option value="">Choose a region…</option>
            {regions.map((r) => (
              <option key={r.region_id} value={r.region_id}>
                {r.name} ({humanize(r.region_type)})
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Latitude" error={fieldError('latitude')} hint="-90 to 90" required>
          <input
            inputMode="decimal"
            value={latitude}
            onChange={(e) => edit('latitude', setLatitude)(e.target.value)}
            className={fieldControlClass(!!fieldError('latitude'))}
          />
        </FormField>
        <FormField label="Longitude" error={fieldError('longitude')} hint="-180 to 180" required>
          <input
            inputMode="decimal"
            value={longitude}
            onChange={(e) => edit('longitude', setLongitude)(e.target.value)}
            className={fieldControlClass(!!fieldError('longitude'))}
          />
        </FormField>
        <FormField label="Habitat" error={fieldError('habitat_type')} required>
          <select
            value={habitat}
            onChange={(e) =>
              edit('habitat_type', (v) => setHabitat(v as HabitatType | ''))(e.target.value)
            }
            className={fieldControlClass(!!fieldError('habitat_type'))}
          >
            <option value="">Choose a habitat…</option>
            {HABITAT_TYPES.map((h) => (
              <option key={h} value={h}>
                {humanize(h)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Description" error={fieldError('description')} hint="Optional.">
          <input
            value={description}
            onChange={(e) => edit('description', setDescription)(e.target.value)}
            className={fieldControlClass(!!fieldError('description'))}
          />
        </FormField>
      </div>
      {note && (
        <p role="status" className="text-sm text-slate-600">
          {note}
        </p>
      )}
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
          {save.submitting ? 'Saving…' : editing ? 'Save changes' : 'Create site'}
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
