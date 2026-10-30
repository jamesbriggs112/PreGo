import type { RunStatus } from '@prego/core/types';
import { Badge } from '@/components/ui/badge';

const LABELS: Record<RunStatus, string> = { running: 'Running', complete: 'Complete', failed: 'Failed', stopped: 'Stopped' };
const VARIANTS = { running: 'brand', complete: 'success', failed: 'critical', stopped: 'secondary' } as const;

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <Badge variant={VARIANTS[status]}>{LABELS[status]}</Badge>;
}
