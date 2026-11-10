import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** 1st, 2nd, 3rd, 4th… */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/** Whether an audit is running now, so start buttons can say they'll queue instead. */
export function useAuditRunning(): boolean {
  const active = useQuery({
    queryKey: ['active-run'],
    queryFn: api.activeRun,
    refetchInterval: 5_000,
  });
  return !!active.data;
}

/** Audits waiting their turn, refreshed often so they move to running without a reload. */
export function useQueue() {
  return useQuery({
    queryKey: ['queue'],
    queryFn: api.queue,
    refetchInterval: 5_000,
  });
}
