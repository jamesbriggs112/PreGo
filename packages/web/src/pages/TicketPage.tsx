import { useState, type FormEvent } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { CATEGORY_NAMES, SEVERITIES, type Priority, type Severity } from '@prego/core/types';
import { api, fileUrl, type TicketChanges, type TicketDetail } from '@/lib/api';
import { useTitle } from '@/lib/use-title';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect } from '@/components/ui/native-select';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SeverityBadge, StatusBadge } from '@/components/TicketBadges';

const PRIORITIES: Priority[] = ['P1', 'P2', 'P3', 'P4'];
const SHOW_FIRST = 12;

export function TicketPage() {
  const params = useParams();
  const runId = Number(params.runId);
  const ticketId = params.ticketId!;
  const from = (useLocation().state as { from?: string } | null)?.from;
  const ticket = useQuery({ queryKey: ['ticket', runId, ticketId], queryFn: () => api.ticket(runId, ticketId) });
  useTitle(ticket.data ? `${ticket.data.ticketId}: ${ticket.data.title}` : ticketId);

  const backTo = `/runs/${runId}?${from ?? 'tab=tickets'}`;
  return (
    <div className="space-y-6">
      <Link to={backTo} className="inline-flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> Back to tickets
      </Link>
      {ticket.isPending && <p>Loading ticket…</p>}
      {ticket.isError && (
        <Alert variant="destructive" role="alert">
          Couldn’t load {ticketId}: {ticket.error.message}. It may have been merged into another ticket.
        </Alert>
      )}
      {ticket.data && <TicketView runId={runId} ticket={ticket.data} />}
    </div>
  );
}

function TicketView({ runId, ticket }: { runId: number; ticket: TicketDetail }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(ticket.title);
  const [severity, setSeverity] = useState<Severity>(ticket.severity);
  const [priority, setPriority] = useState<Priority>(ticket.priority);
  const [notes, setNotes] = useState(ticket.auditorNotes);
  const [showAll, setShowAll] = useState(false);

  const save = useMutation({
    mutationFn: (changes: TicketChanges) => api.updateTicket(runId, ticket.ticketId, changes),
    onSuccess: (updated) => {
      setTitle(updated.title);
      setSeverity(updated.severity);
      setPriority(updated.priority);
      setNotes(updated.auditorNotes);
      void queryClient.invalidateQueries({ queryKey: ['ticket', runId, ticket.ticketId] });
      void queryClient.invalidateQueries({ queryKey: ['tickets', runId] });
      void queryClient.invalidateQueries({ queryKey: ['run', runId] });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const changes: TicketChanges = {};
    if (title !== ticket.title) changes.title = title;
    if (severity !== ticket.severity) changes.severity = severity;
    if (priority !== ticket.priority) changes.priority = priority;
    if (notes !== ticket.auditorNotes) changes.auditorNotes = notes;
    if (Object.keys(changes).length) save.mutate(changes);
  }

  const dismissed = ticket.status === 'Dismissed';
  const needsReview = ticket.status === 'Needs review';
  const occurrences = showAll ? ticket.occurrenceList : ticket.occurrenceList.slice(0, SHOW_FIRST);

  return (
    <>
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">
          <span className="text-primary">{ticket.ticketId}</span> {ticket.title}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={ticket.severity} />
          <Badge variant="outline">{ticket.priority}</Badge>
          <StatusBadge status={ticket.status} />
          <Badge variant="secondary">{CATEGORY_NAMES[ticket.category]}</Badge>
          {ticket.wcagCriterion && (
            <Badge variant="secondary">
              WCAG {ticket.wcagCriterion} ({ticket.wcagLevel})
            </Badge>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader>
            <CardTitle>What’s wrong</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 text-sm">
              <Detail term="Description">{ticket.description}</Detail>
              <Detail term="Why it matters">{ticket.whyItMatters}</Detail>
              <Detail term="Recommendation">{ticket.recommendation}</Detail>
              <Detail term="Steps to reproduce">
                <span className="whitespace-pre-wrap">{ticket.stepsToReproduce}</span>
              </Detail>
              <Detail term="Expected">{ticket.expected}</Detail>
              <Detail term="Actual">
                <span className="whitespace-pre-wrap">{ticket.actual}</span>
              </Detail>
              <Detail term="Rule">
                {ticket.engine} <code className="rounded bg-muted px-1">{ticket.ruleId}</code>
                {ticket.helpUrl && (
                  <>
                    {' · '}
                    <a href={ticket.helpUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline">
                      Rule guidance <ExternalLink className="size-3" aria-hidden="true" />
                      <span className="sr-only">(opens in a new tab)</span>
                    </a>
                  </>
                )}
              </Detail>
              <Detail term="Effort">{ticket.effort}</Detail>
            </dl>
          </CardContent>
        </Card>

        <Card className="self-start">
          <CardHeader>
            <CardTitle>Triage</CardTitle>
            <CardDescription>Changes are saved for this project and carry into later audits and exports.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form onSubmit={onSubmit} className="grid gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="ticket-title">Title</Label>
                <Input id="ticket-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="ticket-severity">Severity</Label>
                  <NativeSelect id="ticket-severity" value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
                    {SEVERITIES.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="ticket-priority">Priority</Label>
                  <NativeSelect id="ticket-priority" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                    {PRIORITIES.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </NativeSelect>
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ticket-notes">Auditor notes</Label>
                <Textarea id="ticket-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} />
              </div>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save changes'}
              </Button>
            </form>
            {needsReview && (
              <div className="border-t pt-4">
                <Button className="w-full" onClick={() => save.mutate({ approved: true })} disabled={save.isPending}>
                  Approve AI suggestion
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">AI-suggested tickets stay out of scores and exports until you approve them. Dismiss it if it’s wrong.</p>
              </div>
            )}
            <div className="border-t pt-4">
              <Button variant={dismissed ? 'outline' : 'secondary'} className="w-full" onClick={() => save.mutate({ dismissed: !dismissed })} disabled={save.isPending}>
                {dismissed ? 'Restore ticket' : 'Dismiss as false positive'}
              </Button>
              <p className="mt-2 text-xs text-muted-foreground">Dismissed tickets are left out of exports.</p>
            </div>
            <p role="status" className="text-sm">
              {save.isSuccess && 'Saved.'}
            </p>
            {save.isError && (
              <Alert variant="destructive" role="alert">
                {save.error.message}
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            Occurrences ({ticket.occurrences} on {ticket.locationsAffected} {ticket.locationsAffected === 1 ? 'page' : 'pages'})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-4 md:grid-cols-2">
            {occurrences.map((o) => (
              <li key={o.id} className="space-y-2 rounded-md border bg-background p-3 text-sm">
                {o.crop ? (
                  <img src={fileUrl(runId, o.crop)} alt={`Problem outlined on ${o.url} at the ${o.viewport} viewport`} className="max-h-64 w-full rounded border object-contain object-left-top" loading="lazy" />
                ) : (
                  <p className="text-muted-foreground">{ticket.screenshotsDeleted ? 'Screenshots are deleted once an audit is exported. This one is in the Word report.' : 'No screenshot for this occurrence.'}</p>
                )}
                <p className="break-all">
                  <span className="font-medium">{o.url}</span> · {o.viewport}
                </p>
                <code className="block overflow-x-auto rounded bg-muted px-2 py-1 text-xs whitespace-pre">{o.selector}</code>
                <code className="block overflow-x-auto rounded bg-muted px-2 py-1 text-xs whitespace-pre">{o.html}</code>
              </li>
            ))}
          </ul>
          {!showAll && ticket.occurrenceList.length > SHOW_FIRST && (
            <Button variant="outline" className="mt-4" onClick={() => setShowAll(true)}>
              Show all {ticket.occurrenceList.length} occurrences
            </Button>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function Detail({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="font-medium">{term}</dt>
      <dd className="text-muted-foreground">{children}</dd>
    </div>
  );
}
