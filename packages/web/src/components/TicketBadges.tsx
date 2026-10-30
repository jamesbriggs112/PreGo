import type { Severity, TicketStatus } from '@prego/core/types';
import { Badge } from '@/components/ui/badge';

const SEVERITY_VARIANTS = { Critical: 'critical', High: 'high', Medium: 'medium', Low: 'low' } as const;

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge variant={SEVERITY_VARIANTS[severity]}>{severity}</Badge>;
}

export function StatusBadge({ status }: { status: TicketStatus }) {
  const variant = status === 'Dismissed' ? 'secondary' : status === 'New' ? 'brand' : 'outline';
  return <Badge variant={variant}>{status}</Badge>;
}
