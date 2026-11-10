import type { ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';

/** Import Google Analytics CSV exports for the project. They stay on this computer. */
export function AnalyticsImport({ projectId }: { projectId: number }) {
  const queryClient = useQueryClient();
  const project = useQuery({ queryKey: ['project', projectId], queryFn: () => api.project(projectId) });
  // Every audit's report state shows whether there are analytics, so refresh them all.
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['project', projectId] }), queryClient.invalidateQueries({ queryKey: ['report'] })]);
  const upload = useMutation({ mutationFn: (files: { name: string; text: string }[]) => api.importAnalytics(projectId, files), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => api.removeAnalytics(projectId), onSuccess: refresh });
  const analytics = project.data?.settings.analytics;

  async function onFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    if (files.length) upload.mutate(await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() }))));
  }

  return (
    <div className="grid gap-3 text-sm">
      {analytics && (
        <p>
          Last import {formatDateTime(analytics.importedAt)}, from {analytics.files.join(', ')}
          {analytics.period ? `, covering ${analytics.period}` : ''}:{' '}
          {[
            ...analytics.tables.map((t) => t.title.toLowerCase()),
            ...(analytics.search ? [`Search Console ${(['queries', 'pages', 'devices', 'countries'] as const).filter((k) => analytics.search![k].length).join(', ')}`] : []),
          ].join('; ')}
          .
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1">
          <Label htmlFor="analytics-files">{analytics ? 'Add or update exports' : 'Google Analytics or Search Console CSV exports'}</Label>
          <input id="analytics-files" type="file" accept=".csv,text/csv" multiple onChange={onFiles} aria-describedby="analytics-files-hint" className="text-sm" />
        </div>
        {analytics && (
          <Button type="button" variant="outline" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
            Remove analytics
          </Button>
        )}
      </div>
      <span id="analytics-files-hint" className="text-muted-foreground">
        In Google Analytics, open Traffic acquisition, Pages and screens, Landing page, Events, Tech details or Demographic details, then Share → Download file → CSV. In
        Search Console, open Performance, then Export → Download CSV, and unzip it. A new export replaces the same report from before; the rest stay. With page figures,
        issues on pages that get a quarter or more of visits move up a priority level. Shared by every audit of this project, and kept on this computer.
      </span>
      {upload.isPending && <p role="status">Importing…</p>}
      {(upload.isError || remove.isError) && (
        <Alert variant="destructive" role="alert">
          {(upload.error ?? remove.error)?.message}
        </Alert>
      )}
    </div>
  );
}
