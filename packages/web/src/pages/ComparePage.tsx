import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { CATEGORY_NAMES, type Category } from '@prego/core/types';
import { api, type ComparedTicket, type Comparison } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { useTitle } from '@/lib/use-title';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SeverityBadge } from '@/components/TicketBadges';

export function ComparePage() {
  const runId = Number(useParams().runId);
  const [params] = useSearchParams();
  const withId = params.get('with') ? Number(params.get('with')) : undefined;
  const comparison = useQuery({ queryKey: ['compare', runId, withId], queryFn: () => api.compare(runId, withId) });
  useTitle(comparison.data ? `Compare audits: ${comparison.data.project.name}` : 'Compare audits');

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm">
        <Link to={`/runs/${runId}`}>
          <ArrowLeft aria-hidden="true" /> Back to the audit
        </Link>
      </Button>
      {comparison.isPending && <p>Comparing…</p>}
      {comparison.isError && (
        <Alert variant="destructive" role="alert">
          {comparison.error.message}
        </Alert>
      )}
      {comparison.data && <CompareView data={comparison.data} />}
    </div>
  );
}

function CompareView({ data }: { data: Comparison }) {
  const navigate = useNavigate();
  const categories = [...new Set([...Object.keys(data.base.scores), ...Object.keys(data.target.scores)])] as Category[];
  const label = (run: { id: number; startedAt: string }) => `${formatDateTime(run.startedAt)} (audit ${run.id})`;
  const choose = (which: 'base' | 'target', id: number) => {
    const base = which === 'base' ? id : data.base.id;
    const target = which === 'target' ? id : data.target.id;
    navigate(`/runs/${target}/compare?with=${base}`);
  };

  return (
    <>
      <div>
        <h1 className="text-2xl font-bold">Compare audits: {data.project.name}</h1>
        <p className="text-muted-foreground">What changed between two audits of the same project.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Audits</CardTitle>
          <CardDescription>The earlier audit is always on the left.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {(['base', 'target'] as const).map((which) => (
            <div key={which} className="grid gap-2">
              <Label htmlFor={`compare-${which}`}>{which === 'base' ? 'Earlier audit' : 'Later audit'}</Label>
              <NativeSelect id={`compare-${which}`} value={data[which].id} onChange={(e) => choose(which, Number(e.target.value))}>
                {data.runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {label(r)}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ))}
        </CardContent>
      </Card>

      <section aria-labelledby="changes-heading" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <h2 id="changes-heading" className="sr-only">
          Changes
        </h2>
        <Count label="Fixed" value={data.fixed.length} />
        <Count label="New" value={data.added.length} />
        <Count label="Back again" value={data.regressed.length} />
        <Count label="Still present" value={data.recurring.length} />
      </section>

      {categories.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Scores</CardTitle>
            <CardDescription>Scores are an indicator for comparing audits, not a measure of compliance.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Category</TableHead>
                  <TableHead scope="col">Earlier</TableHead>
                  <TableHead scope="col">Later</TableHead>
                  <TableHead scope="col">Change</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categories.map((c) => {
                  const before = data.base.scores[c];
                  const after = data.target.scores[c];
                  const change = before !== undefined && after !== undefined ? after - before : null;
                  return (
                    <TableRow key={c}>
                      <TableHead scope="row" className="font-medium">
                        {CATEGORY_NAMES[c]}
                      </TableHead>
                      <TableCell>{before ?? 'Not checked'}</TableCell>
                      <TableCell>{after ?? 'Not checked'}</TableCell>
                      <TableCell>{change === null ? '–' : change > 0 ? `+${change}` : String(change)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <TicketList title="Fixed" description="In the earlier audit, checked for again and not found." tickets={data.fixed} runId={data.base.id} />
      <TicketList title="New" description="Found in the later audit for the first time." tickets={data.added} runId={data.target.id} />
      <TicketList title="Back again" description="Fixed at some point, and found again in the later audit." tickets={data.regressed} runId={data.target.id} />
      <TicketList title="Still present" description="Found in both audits." tickets={data.recurring} runId={data.target.id} />
      {data.notChecked.length > 0 && (
        <TicketList
          title="Not checked in the later audit"
          description="The later audit didn’t run the check that found these, so there’s no way to tell whether they’re fixed."
          tickets={data.notChecked}
          runId={data.base.id}
        />
      )}
    </>
  );
}

function Count({ label, value }: { label: string; value: number }) {
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

function TicketList({ title, description, tickets, runId }: { title: string; description: string; tickets: ComparedTicket[]; runId: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">
          {title} ({tickets.length})
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {tickets.length === 0 ? (
          <p className="text-muted-foreground">None.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Ticket</TableHead>
                <TableHead scope="col">Category</TableHead>
                <TableHead scope="col">Severity</TableHead>
                <TableHead scope="col">Priority</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tickets.map((t) => (
                <TableRow key={t.ticketId}>
                  <TableCell>
                    <Link to={`/runs/${runId}/tickets/${encodeURIComponent(t.ticketId)}`} className="font-medium underline-offset-4 hover:underline">
                      <span className="font-mono">{t.ticketId}</span>: {t.title}
                    </Link>
                  </TableCell>
                  <TableCell>{CATEGORY_NAMES[t.category]}</TableCell>
                  <TableCell>
                    <SeverityBadge severity={t.severity} />
                  </TableCell>
                  <TableCell>{t.priority}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
