import { Link } from 'react-router';
import { ListOrdered } from 'lucide-react';
import type { QueuedAudit } from '@/lib/api';
import { ordinal } from '@/lib/use-queue';
import { Alert } from '@/components/ui/alert';

/** Shown after starting an audit while another was running: it's waiting its turn. */
export function QueuedNotice({ queued, runningId }: { queued: QueuedAudit; runningId: number | null }) {
  return (
    <Alert role="status" className="flex items-start gap-2">
      <ListOrdered aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>
        <strong>Added to the queue, {ordinal(queued.position)} in line.</strong> The audit of {queued.project} starts by itself when the one before it finishes. Queued audits are
        kept until Prego closes.{' '}
        {runningId && (
          <Link to={`/runs/${runningId}`} className="font-medium underline">
            Watch the running audit
          </Link>
        )}
      </span>
    </Alert>
  );
}
