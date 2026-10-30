import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useTitle } from '@/lib/use-title';
import { formatDateTime } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { RunStatusBadge } from '@/components/RunStatusBadge';
import { LiveRun } from './LiveRun';

export function RunPage() {
  const runId = Number(useParams().runId);
  const run = useQuery({ queryKey: ['run', runId], queryFn: () => api.run(runId) });
  useTitle(run.data ? `${run.data.status === 'running' ? 'Auditing' : 'Audit of'} ${run.data.project.name}` : `Audit ${runId}`);

  if (run.isPending) return <p>Loading audit…</p>;
  if (run.isError)
    return (
      <Alert variant="destructive" role="alert">
        Couldn’t load this audit: {run.error.message}. <Link to="/" className="underline">Back to projects</Link>
      </Alert>
    );
  if (run.data.status === 'running') return <LiveRun run={run.data} />;

  const s = run.data.summary as Record<string, number>;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Audit of {run.data.project.name}</h1>
        <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
          <span className="break-all">{run.data.target}</span> · {formatDateTime(run.data.startedAt)} <RunStatusBadge status={run.data.status} />
        </p>
      </div>
      {run.data.status === 'stopped' && <Alert>This audit was stopped before it finished. Start a new audit to get full results.</Alert>}
      {run.data.status === 'failed' && (
        <Alert variant="destructive" role="alert">
          The audit failed: {run.data.error}
        </Alert>
      )}
      {run.data.status === 'complete' && (
        <p>
          {s.pagesFound} pages found, {s.pagesAudited} audited, {s.tickets} tickets.
        </p>
      )}
    </div>
  );
}
