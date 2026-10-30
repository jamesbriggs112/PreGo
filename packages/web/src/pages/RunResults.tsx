import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Merge } from 'lucide-react';
import { CATEGORY_NAMES, SEVERITIES, type Category } from '@prego/core/types';
import { api, type ApiTicket, type RunDetail } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { RunStatusBadge } from '@/components/RunStatusBadge';
import { SeverityBadge, StatusBadge } from '@/components/TicketBadges';

const STATUS_FILTERS = [
  { value: 'open', label: 'Open (not dismissed)' },
  { value: 'all', label: 'All' },
  { value: 'New', label: 'New' },
  { value: 'Recurring', label: 'Recurring' },
  { value: 'Dismissed', label: 'Dismissed' },
];

export function RunResults({ run }: { run: RunDetail }) {
  const queryClient = useQueryClient();
  const tickets = useQuery({ queryKey: ['tickets', run.id], queryFn: () => api.tickets(run.id) });
  const [params, setParams] = useSearchParams();
  const filters = {
    category: params.get('category') ?? '',
    severity: params.get('severity') ?? '',
    status: params.get('status') ?? 'open',
    page: params.get('page') ?? '',
    q: params.get('q') ?? '',
  };
  const setFilter = (key: keyof typeof filters, value: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );

  const [selected, setSelected] = useState<string[]>([]);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [keep, setKeep] = useState('');
  const merge = useMutation({
    mutationFn: () => api.mergeTickets(run.id, keep, selected.filter((id) => id !== keep)),
    onSuccess: () => {
      setMergeOpen(false);
      setSelected([]);
      void queryClient.invalidateQueries({ queryKey: ['tickets', run.id] });
      void queryClient.invalidateQueries({ queryKey: ['run', run.id] });
    },
  });

  const all = useMemo(() => tickets.data ?? [], [tickets.data]);
  const visible = all.filter((t) => matches(t, filters));
  const categories = [...new Set(all.map((t) => t.category))] as Category[];
  const pages = [...new Set(all.flatMap((t) => t.pages))].sort();
  const selectedTickets = all.filter((t) => selected.includes(t.ticketId));
  const s = run.summary as Record<string, number>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Audit of {run.project.name}</h1>
          <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
            <span className="break-all">{run.target}</span> · {formatDateTime(run.startedAt)} <RunStatusBadge status={run.status} />
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {run.mode === 'explore' && (
            <Button asChild variant="outline">
              <Link to={`/runs/${run.id}/map`}>State map</Link>
            </Button>
          )}
          <Button asChild>
            <Link to={`/runs/${run.id}/export`}>Export report and tickets</Link>
          </Button>
        </div>
      </div>

      <section aria-labelledby="summary-heading" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <h2 id="summary-heading" className="sr-only">
          Summary
        </h2>
        {Object.entries(run.scores ?? {}).map(([category, score]) => (
          <Card key={category}>
            <CardHeader>
              <CardDescription>{CATEGORY_NAMES[category as Category]} score</CardDescription>
              <CardTitle as="h3" className="text-3xl">
                {score}
                <span className="text-base font-normal text-muted-foreground"> / 100</span>
              </CardTitle>
            </CardHeader>
          </Card>
        ))}
        <Stat label="Open tickets" value={all.filter((t) => t.status !== 'Dismissed').length} />
        {run.mode === 'explore' ? (
          <Stat label="Screens audited" value={s.statesAudited ?? 0} />
        ) : run.mode === 'journey' ? (
          <Stat label="Journey steps audited" value={`${s.stepsReplayed} of ${s.stepsRecorded}`} />
        ) : (
          <>
            <Stat label="Pages audited" value={`${s.pagesAudited} of ${s.pagesFound}`} />
            <Stat label="Broken links" value={s.brokenLinks ?? 0} />
          </>
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Tickets</CardTitle>
          <CardDescription>Open a ticket to edit, dismiss or add notes. Select two or more to merge them.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form role="search" aria-label="Filter tickets" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" onSubmit={(e) => e.preventDefault()}>
            <FilterSelect id="filter-category" label="Category" value={filters.category} onChange={(v) => setFilter('category', v)}>
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_NAMES[c]}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect id="filter-severity" label="Severity" value={filters.severity} onChange={(v) => setFilter('severity', v)}>
              <option value="">All severities</option>
              {SEVERITIES.map((sev) => (
                <option key={sev} value={sev}>
                  {sev}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect id="filter-status" label="Status" value={filters.status} onChange={(v) => setFilter('status', v === 'open' ? '' : v)}>
              {STATUS_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect id="filter-page" label={run.mode === 'crawl' ? 'Page' : run.mode === 'journey' ? 'Step' : 'Screen'} value={filters.page} onChange={(v) => setFilter('page', v)}>
              <option value="">{run.mode === 'crawl' ? 'All pages' : run.mode === 'journey' ? 'All steps' : 'All screens'}</option>
              {pages.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </FilterSelect>
            <div className="grid gap-1.5">
              <Label htmlFor="filter-q">Search</Label>
              <Input id="filter-q" type="search" value={filters.q} onChange={(e) => setFilter('q', e.target.value)} placeholder="ID, title or rule" />
            </div>
          </form>

          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              disabled={selected.length < 2}
              onClick={() => {
                setKeep(selected[0]);
                merge.reset();
                setMergeOpen(true);
              }}
            >
              <Merge aria-hidden="true" /> Merge selected ({selected.length})
            </Button>
            {selected.length > 0 && (
              <Button variant="ghost" onClick={() => setSelected([])}>
                Clear selection
              </Button>
            )}
          </div>

          {tickets.isPending && <p>Loading tickets…</p>}
          {tickets.isError && (
            <Alert variant="destructive" role="alert">
              Couldn’t load tickets: {tickets.error.message}
            </Alert>
          )}
          {tickets.data && (
            <Table>
              <TableCaption aria-live="polite">
                {visible.length} of {all.length} tickets shown
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col" className="w-10">
                    <span className="sr-only">Select</span>
                  </TableHead>
                  <TableHead scope="col">Ticket</TableHead>
                  <TableHead scope="col">Severity</TableHead>
                  <TableHead scope="col">Priority</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col" className="text-right">
                    Occurrences
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    {run.mode === 'crawl' ? 'Pages' : run.mode === 'journey' ? 'Steps' : 'Screens'}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((t) => (
                  <TableRow key={t.ticketId} data-state={selected.includes(t.ticketId) ? 'selected' : undefined}>
                    <TableCell>
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        aria-label={`Select ${t.ticketId}`}
                        checked={selected.includes(t.ticketId)}
                        onChange={(e) => setSelected((cur) => (e.target.checked ? [...cur, t.ticketId] : cur.filter((id) => id !== t.ticketId)))}
                      />
                    </TableCell>
                    <TableCell>
                      <Link to={`/runs/${run.id}/tickets/${t.ticketId}`} state={{ from: params.toString() }} className="group">
                        <span className="font-semibold text-primary underline-offset-2 group-hover:underline">{t.ticketId}</span>
                        <span className="block text-foreground">{t.title}</span>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <SeverityBadge severity={t.severity} />
                    </TableCell>
                    <TableCell>{t.priority}</TableCell>
                    <TableCell>
                      <StatusBadge status={t.status} />
                    </TableCell>
                    <TableCell className="text-right">{t.occurrences}</TableCell>
                    <TableCell className="text-right">{t.locationsAffected}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={mergeOpen} onOpenChange={setMergeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge {selectedTickets.length} tickets</DialogTitle>
            <DialogDescription>Choose the ticket to keep. The others’ occurrences move into it, and later audits keep them together.</DialogDescription>
          </DialogHeader>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Keep</legend>
            {selectedTickets.map((t) => (
              <div key={t.ticketId} className="flex items-start gap-2">
                <input
                  type="radio"
                  id={`keep-${t.ticketId}`}
                  name="keep"
                  value={t.ticketId}
                  checked={keep === t.ticketId}
                  onChange={() => setKeep(t.ticketId)}
                  className="mt-0.5 size-4 accent-primary"
                />
                <Label htmlFor={`keep-${t.ticketId}`} className="font-normal leading-snug">
                  <span className="font-semibold">{t.ticketId}</span> {t.title}
                </Label>
              </div>
            ))}
          </fieldset>
          {merge.isError && (
            <Alert variant="destructive" role="alert">
              {merge.error.message}
            </Alert>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMergeOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => merge.mutate()} disabled={merge.isPending || !keep}>
              {merge.isPending ? 'Merging…' : `Merge into ${keep}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function matches(t: ApiTicket, f: { category: string; severity: string; status: string; page: string; q: string }): boolean {
  if (f.category && t.category !== f.category) return false;
  if (f.severity && t.severity !== f.severity) return false;
  if (f.status === 'open' && t.status === 'Dismissed') return false;
  if (f.status !== 'open' && f.status !== 'all' && t.status !== f.status) return false;
  if (f.page && !t.pages.includes(f.page)) return false;
  const q = f.q.trim().toLowerCase();
  if (q && ![t.ticketId, t.title, t.ruleId].some((field) => field.toLowerCase().includes(q))) return false;
  return true;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle as="h3" className="text-3xl">
          {value}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}

function FilterSelect({ id, label, value, onChange, children }: { id: string; label: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </NativeSelect>
    </div>
  );
}
