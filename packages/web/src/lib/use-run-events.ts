import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/** Mirrors the server's JobEvent type (packages/server/src/jobs.ts). */
export type RunEvent =
  | { type: 'started'; runId: number; projectId: number }
  | { type: 'phase'; phase: 'crawl' | 'group' | 'audit' | 'tickets' | 'done'; message: string }
  | { type: 'page-found'; url: string; count: number }
  | { type: 'location-audited'; url: string; viewport: string; findings: number; done: number; total: number; screenshot: string }
  | { type: 'warning'; message: string }
  | { type: 'end'; status: 'running' | 'complete' | 'failed' | 'stopped'; error?: string };

/**
 * Subscribe to a run's live events. The server replays the whole history on every connection, so
 * the list is reset each time the stream (re)opens.
 */
export function useRunEvents(runId: number, enabled: boolean): { events: RunEvent[]; connected: boolean } {
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.onopen = () => {
      setConnected(true);
      setEvents([]);
    };
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as RunEvent;
      setEvents((current) => [...current, event]);
      if (event.type === 'end') {
        source.close();
        setConnected(false);
        void queryClient.invalidateQueries({ queryKey: ['run', runId] });
        void queryClient.invalidateQueries({ queryKey: ['projects'] });
      }
    };
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [runId, enabled, queryClient]);

  return { events, connected };
}
