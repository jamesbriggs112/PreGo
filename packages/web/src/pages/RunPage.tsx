import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useTitle } from '@/lib/use-title';
import { RunStatusBadge } from '@/components/RunStatusBadge';

export function RunPage() {
  const runId = Number(useParams().runId);
  useTitle(`Audit ${runId}`);
  const run = useQuery({ queryKey: ['run', runId], queryFn: () => api.run(runId), refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false) });
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-bold">Audit {runId}</h1>
      {run.data && (
        <p className="flex items-center gap-2">
          {run.data.project.name}: {run.data.target} <RunStatusBadge status={run.data.status} />
        </p>
      )}
    </div>
  );
}
