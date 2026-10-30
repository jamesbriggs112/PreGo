import { useMutation } from '@tanstack/react-query';
import { Square } from 'lucide-react';
import { api, fileUrl, type RunDetail } from '@/lib/api';
import { useRunEvents, type RunEvent } from '@/lib/use-run-events';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const PHASES = ['crawl', 'group', 'audit', 'tickets'] as const;
const PHASE_LABELS: Record<(typeof PHASES)[number], string> = {
  crawl: 'Finding pages',
  group: 'Grouping templates',
  audit: 'Checking pages',
  tickets: 'Building tickets',
};

type Audited = Extract<RunEvent, { type: 'location-audited' }>;

export function LiveRun({ run }: { run: RunDetail }) {
  const { events } = useRunEvents(run.id, true);
  const stop = useMutation({ mutationFn: () => api.stopRun(run.id) });

  const phases = events.filter((e) => e.type === 'phase');
  const phase = phases.at(-1);
  const found = events.filter((e) => e.type === 'page-found');
  const audited = events.filter((e): e is Audited => e.type === 'location-audited');
  const latest = audited.at(-1);
  const end = events.find((e) => e.type === 'end');
  const auditedUrls = new Set(audited.map((a) => a.url));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Auditing {run.project.name}</h1>
          <p className="text-muted-foreground break-all">{run.target}</p>
        </div>
        <Button variant="destructive" onClick={() => stop.mutate()} disabled={stop.isPending || stop.isSuccess || !!end}>
          <Square aria-hidden="true" />
          {stop.isSuccess && !end ? 'Stopping…' : 'Stop audit'}
        </Button>
      </div>

      {stop.isError && (
        <Alert variant="destructive" role="alert">
          {stop.error.message}
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Progress</CardTitle>
          {/* Announced to screen readers as the audit moves through its phases. */}
          <CardDescription aria-live="polite">{end ? 'Finishing up…' : (phase?.message ?? 'Starting…')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ol className="flex flex-wrap gap-2" aria-label="Phases">
            {PHASES.map((p) => {
              const index = PHASES.indexOf(p);
              const currentIndex = phase && phase.phase !== 'done' ? PHASES.indexOf(phase.phase) : end ? PHASES.length : -1;
              const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo';
              return (
                <li
                  key={p}
                  aria-current={state === 'current' ? 'step' : undefined}
                  className={
                    state === 'current'
                      ? 'rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground'
                      : state === 'done'
                        ? 'rounded-md bg-secondary px-3 py-1 text-sm text-secondary-foreground'
                        : 'rounded-md border px-3 py-1 text-sm text-muted-foreground'
                  }
                >
                  {PHASE_LABELS[p]}
                  {state === 'done' && <span className="sr-only"> (done)</span>}
                </li>
              );
            })}
          </ol>
          <div className="grid gap-2">
            <label htmlFor="audit-progress" className="text-sm font-medium">
              {latest ? `${latest.done} of ${latest.total} page checks done` : `${found.length} ${found.length === 1 ? 'page' : 'pages'} found so far`}
            </label>
            <progress id="audit-progress" className="h-2 w-full accent-primary" max={latest?.total ?? 1} value={latest ? latest.done : undefined} />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Current page</CardTitle>
            <CardDescription>{latest ? `${latest.url} at ${latest.viewport}: ${latest.findings} findings` : 'The first screenshot appears once a page has been checked.'}</CardDescription>
          </CardHeader>
          <CardContent>
            {latest && (
              // Focusable so keyboard users can scroll the screenshot.
              <div tabIndex={0} role="region" aria-label="Screenshot of the current page" className="max-h-[28rem] overflow-y-auto rounded-md border bg-background">
                <img key={latest.screenshot} src={fileUrl(run.id, latest.screenshot)} alt={`Screenshot of ${latest.url} at the ${latest.viewport} viewport`} className="w-full" />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pages found ({found.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <ul tabIndex={0} aria-label="Pages found" className="max-h-[28rem] space-y-1 overflow-y-auto text-sm">
              {found.map((page) => (
                <li key={page.url} className="flex items-center justify-between gap-3 border-b py-1.5 last:border-0">
                  <span className="break-all">{page.url}</span>
                  <span className="shrink-0 text-muted-foreground">{auditedUrls.has(page.url) ? 'Checked' : 'Found'}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
