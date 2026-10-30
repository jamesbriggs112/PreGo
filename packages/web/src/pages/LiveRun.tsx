import { useMemo } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Square } from 'lucide-react';
import { api, fileUrl, type RunDetail } from '@/lib/api';
import { useRunEvents, type RunEvent } from '@/lib/use-run-events';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StateMapDiagram } from '@/components/StateMapDiagram';

type Phase = 'crawl' | 'group' | 'explore' | 'audit' | 'tickets';
const CRAWL_PHASES: Phase[] = ['crawl', 'group', 'audit', 'tickets'];
const EXPLORE_PHASES: Phase[] = ['explore', 'audit', 'tickets'];
const PHASE_LABELS: Record<Phase, string> = {
  crawl: 'Finding pages',
  group: 'Grouping templates',
  explore: 'Exploring screens',
  audit: 'Checking',
  tickets: 'Building tickets',
};
type Found = Extract<RunEvent, { type: 'state-found' }>;

type Audited = Extract<RunEvent, { type: 'location-audited' }>;

export function LiveRun({ run }: { run: RunDetail }) {
  const { events } = useRunEvents(run.id, true);
  const stop = useMutation({ mutationFn: () => api.stopRun(run.id) });

  const explore = run.mode === 'explore';
  const PHASES = explore ? EXPLORE_PHASES : CRAWL_PHASES;
  const phases = events.filter((e) => e.type === 'phase');
  const phase = phases.at(-1);
  const found = events.filter((e) => e.type === 'page-found');
  const screens = events.filter((e): e is Found => e.type === 'state-found');
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
              const currentIndex = phase && phase.phase !== 'done' ? PHASES.indexOf(phase.phase as Phase) : end ? PHASES.length : -1;
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
              {latest
                ? `${latest.done} of ${latest.total} ${explore ? 'screen' : 'page'} checks done`
                : explore
                  ? `${screens.length} ${screens.length === 1 ? 'screen' : 'screens'} found so far`
                  : `${found.length} ${found.length === 1 ? 'page' : 'pages'} found so far`}
            </label>
            <progress id="audit-progress" className="h-2 w-full accent-primary" max={latest?.total ?? 1} value={latest ? latest.done : undefined} />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{explore ? 'Current screen' : 'Current page'}</CardTitle>
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

        {explore ? (
          <Card>
            <CardHeader>
              <CardTitle>Screens found ({screens.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <LiveMap screens={screens} />
            </CardContent>
          </Card>
        ) : (
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
        )}
      </div>
    </div>
  );
}

/** The state map as it grows: each screen joined to the screen it was found from. */
function LiveMap({ screens }: { screens: Found[] }) {
  const { states, edges } = useMemo(() => {
    const ids = new Map(screens.map((s, i) => [s.stateId, i + 1]));
    const keys = new Map<string, string[]>();
    const states = screens.map((s) => {
      const stepKeys = s.fromStateId ? [...(keys.get(s.fromStateId) ?? []), s.stateId] : [];
      keys.set(s.stateId, stepKeys);
      return { id: ids.get(s.stateId)!, title: s.title, depth: s.depth, stepKeys };
    });
    const edges = screens
      .filter((s) => s.fromStateId && ids.has(s.fromStateId))
      .map((s) => ({ from: ids.get(s.fromStateId!)!, to: ids.get(s.stateId)!, label: s.action ?? '', outcome: 'navigated' }));
    return { states, edges };
  }, [screens]);
  if (states.length === 0) return <p className="text-sm text-muted-foreground">The first screen appears in a moment.</p>;
  // Keyed on the count so the view re-fits as screens arrive.
  return <StateMapDiagram key={states.length} states={states} edges={edges} label={`State map so far: ${states.length} screens`} height={448} />;
}
