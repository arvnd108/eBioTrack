// Owner: B (Frontend)
// Purpose: Project sites: list, link and unlink (owner/manager PI or administrator)
//
// A site that collection events in this project already use cannot be unlinked: the API answers
// 409 `conflict` and the message is shown above the table.

import { useState, type FormEvent } from 'react';
import { Badge } from '../../components/common/Badge';
import { ConfirmButton } from '../../components/common/ConfirmButton';
import { DataTable, type Column } from '../../components/common/DataTable';
import { ErrorState } from '../../components/common/ErrorState';
import { FormField } from '../../components/common/FormField';
import { useSubmit } from '../../hooks/useSubmit';
import { formErrors } from '../../services/errorMessages';
import { addSite, removeSite } from '../../services/projectsService';
import type { ProjectDetail, Site } from '../../types';
import { SitePicker, useSiteList } from './Pickers';

interface SitesSectionProps {
  project: ProjectDetail;
  canEdit: boolean;
  onChanged: () => void;
}

const coordinate = (value: number) => value.toFixed(4);

export function SitesSection({ project, canEdit, onChanged }: SitesSectionProps) {
  const [siteId, setSiteId] = useState('');
  const [siteError, setSiteError] = useState<string | null>(null);
  const sites = useSiteList(canEdit);
  const link = useSubmit(addSite);
  const unlink = useSubmit(async (projectId: number, id: number) => {
    await removeSite(projectId, id);
    return true; // removeSite resolves to nothing; true marks success for run()
  });
  const listed = sites.status !== 'error';

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = Number(siteId);
    if (!siteId || !Number.isSafeInteger(id) || id <= 0) {
      setSiteError(listed ? 'Choose a site.' : 'Enter the site ID.');
      return;
    }
    setSiteError(null);
    if (await link.run(project.project_id, id)) {
      setSiteId('');
      onChanged();
    }
  }

  async function handleRemove(site: Site) {
    if (await unlink.run(project.project_id, site.site_id)) onChanged();
  }

  const server = link.error
    ? formErrors(link.error, ['site_id'] as const, {
        duplicate: { field: 'site_id', message: 'This site is already linked to the project.' },
      })
    : { fieldErrors: {}, formError: null };

  const columns: Column<Site>[] = [
    { key: 'name', header: 'Site' },
    { key: 'habitat_type', header: 'Habitat', render: (s) => <Badge value={s.habitat_type} /> },
    {
      key: 'location',
      header: 'Latitude, longitude',
      render: (s) => `${coordinate(s.latitude)}, ${coordinate(s.longitude)}`,
    },
    { key: 'description', header: 'Description' },
  ];
  if (canEdit) {
    columns.push({
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (s) => (
        <ConfirmButton
          label="Unlink"
          ariaLabel={`Unlink ${s.name}`}
          confirmLabel="Unlink site?"
          onConfirm={() => handleRemove(s)}
          disabled={unlink.submitting}
        />
      ),
    });
  }

  return (
    <section aria-labelledby="sites-heading" className="space-y-3">
      <h2 id="sites-heading" className="text-lg font-semibold">
        Sites <span className="text-sm font-normal text-slate-500">({project.site_count})</span>
      </h2>
      {unlink.error ? <ErrorState error={unlink.error} title="Could not unlink the site" /> : null}
      <DataTable
        caption="Sites"
        columns={columns}
        rows={project.sites}
        rowKey={(s) => s.site_id}
        emptyTitle="No sites linked"
        emptyDescription={canEdit ? 'Link a sampling site below.' : undefined}
      />
      {canEdit && (
        <form
          onSubmit={handleAdd}
          noValidate
          aria-label="Link site"
          className="grid items-end gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-[1fr_auto]"
        >
          <FormField
            label="Site"
            error={siteError ?? server.fieldErrors.site_id}
            hint={listed ? undefined : 'The site list could not be loaded; enter the site ID.'}
            required
          >
            <SitePicker
              value={siteId}
              onChange={setSiteId}
              exclude={project.sites.map((s) => s.site_id)}
              invalid={!!(siteError ?? server.fieldErrors.site_id)}
              sites={sites}
            />
          </FormField>
          <button
            type="submit"
            disabled={link.submitting}
            className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
          >
            {link.submitting ? 'Linking…' : 'Link site'}
          </button>
          {server.formError && (
            <p role="alert" className="text-sm text-red-700 sm:col-span-2">
              {server.formError}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
