import type { Severity, TicketStatus } from '@prego/core/types';
import { Badge } from '@/components/ui/badge';

const SEVERITY_VARIANTS = { Critical: 'critical', High: 'high', Medium: 'medium', Low: 'low' } as const;

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge variant={SEVERITY_VARIANTS[severity]}>{severity}</Badge>;
}

/** Only dismissed tickets and unapproved AI suggestions get a badge; open tickets need none. */
export function StatusBadge({ status }: { status: TicketStatus }) {
  if (status === 'Open') return null;
  return <Badge variant={status === 'Dismissed' ? 'secondary' : 'outline'}>{status}</Badge>;
}
