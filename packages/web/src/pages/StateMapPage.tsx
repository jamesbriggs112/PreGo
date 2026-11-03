import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import type { Severity } from '@prego/core/types';
import { api, fileUrl, type StateMapData } from '@/lib/api';
import { useTitle } from '@/lib/use-title';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SeverityBadge } from '@/components/TicketBadges';
import { StateMapDiagram } from '@/components/StateMapDiagram';

const OUTCOME_LABELS: Record<string, string> = {
  navigated: 'Goes to',
  unchanged: 'Does nothing',
  changed: 'Changes this screen',
  external: 'Link to another site (not followed)',
  skipped: 'Not pressed',
  limit: 'Not explored (limit reached)',
  failed: 'Could not be pressed',
};

export function StateMapPage() {
  const runId = Number(useParams().runId);
  const run = useQuery({ queryKey: ['run', runId], queryFn: () => api.run(runId) });
  const map = useQuery({ queryKey: ['state-map', runId], queryFn: () => api.stateMap(runId) });
  useTitle(run.data ? `State map: ${run.data.project.name}` : 'State map');

  return (
    <div className="space-y-6">
      <Link to={`/runs/${runId}`} className="inline-flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> Back to results
      </Link>
      <div>
        <h1 className="text-2xl font-bold">State map{run.data ? `: ${run.data.project.name}` : ''}</h1>
        <p className="text-muted-foreground">Every screen Prego reached, arranged by how many taps it is from the start. Select a screen to see it and its issues.</p>
      </div>
      {map.isPending && <p>Loading the state map…</p>}
      {map.isError && (
        <Alert variant="destructive" role="alert">
          {map.error.message}
        </Alert>
      )}
      {map.data && (map.data.states.length ? <MapView runId={runId} data={map.data} /> : <p>This audit has no explored screens.</p>)}
    </div>
  );
}

function MapView({ runId, data }: { runId: number; data: StateMapData }) {
  const [selected, setSelected] = useState<number>(data.states[0].id);
  const [showAll, setShowAll] = useState(false);
  const states = useMemo(
    () =>
      data.states.map((s) => ({
        id: s.id,
        title: s.title,
        depth: s.depth,
        stepKeys: s.steps.map((step) => step.key),
        issues: s.tickets.length,
        flagged: s.tickets.some((t) => t.category === 'UX'),
      })),
    [data.states],
  );
  const current = data.states.find((s) => s.id === selected)!;
  const titleOf = (id: number | null) => data.states.find((s) => s.id === id)?.title ?? '';
  const actions = data.edges.filter((e) => e.from === selected);

  return (
    <>
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>
              {data.states.length} screens, {Math.max(...data.states.map((s) => s.depth))} taps deep
            </CardTitle>
            <CardDescription>Screens with a usability problem of their own (a dead end or a broken button) have a thick red border. Solid lines are the first route to each screen.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="show-all-routes" checked={showAll} onCheckedChange={(state) => setShowAll(state === true)} />
            <Label htmlFor="show-all-routes" className="font-normal">
              Show every route (dashed)
            </Label>
          </div>
        </CardHeader>
        <CardContent>
          <StateMapDiagram states={states} edges={data.edges} selected={selected} onSelect={setSelected} showAll={showAll} label={`State map of ${data.states.length} screens`} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
        <Card>
          <CardHeader>
            <CardTitle>Screens</CardTitle>
            <CardDescription>The same screens as a list.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Screen</TableHead>
                  <TableHead scope="col">Taps from start</TableHead>
                  <TableHead scope="col">Issues</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.states.map((s) => (
                  <TableRow key={s.id} data-state={s.id === selected ? 'selected' : undefined}>
                    <TableCell>
                      <Button variant="link" className="h-auto p-0" aria-pressed={s.id === selected} onClick={() => setSelected(s.id)}>
                        {s.title}
                      </Button>
                    </TableCell>
                    <TableCell>{s.depth}</TableCell>
                    <TableCell>{s.tickets.length}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="self-start" aria-live="polite">
          <CardHeader>
            <CardTitle as="h2">{current.title}</CardTitle>
            <CardDescription>
              {current.depth === 0 ? 'The start screen.' : `Reached by pressing ${current.steps.map((s) => `“${s.label}”`).join(', then ')}.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {current.screenshot ? (
              <img src={fileUrl(runId, current.screenshot)} alt={`Screenshot of the ${current.title} screen`} className="w-full rounded border" />
            ) : (
              data.screenshotsDeleted && <p className="text-muted-foreground">Screenshots are deleted once an audit is exported. They’re in the Word report.</p>
            )}
            <div>
              <h3 className="mb-1 font-medium">Issues on this screen</h3>
              {current.tickets.length === 0 ? (
                <p className="text-muted-foreground">None found by automated checks.</p>
              ) : (
                <ul className="space-y-1">
                  {current.tickets.map((t) => (
                    <li key={t.ticketId} className="flex items-start gap-2">
                      <SeverityBadge severity={t.severity as Severity} />
                      <Link to={`/runs/${runId}/tickets/${t.ticketId}`} className="text-primary underline-offset-2 hover:underline">
                        <span className="font-semibold">{t.ticketId}</span> {t.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="mb-1 font-medium">What each action does</h3>
              {actions.length === 0 ? (
                <p className="text-muted-foreground">Nothing on this screen can be pressed.</p>
              ) : (
                <ul className="space-y-1">
                  {actions.map((e, i) => (
                    <li key={i}>
                      <span className="font-medium">“{e.label}”</span>: {OUTCOME_LABELS[e.outcome] ?? e.outcome}
                      {e.outcome === 'navigated' && ` “${titleOf(e.to)}”`}
                      {e.reason && <span className="text-muted-foreground"> ({e.reason})</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
