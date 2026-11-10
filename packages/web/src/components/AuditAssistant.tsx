import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import { PROFILES, type ProfileName } from '@prego/core/profiles';
import { api, type AuditPlan } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { Textarea } from '@/components/ui/textarea';
import { QueuedNotice } from '@/components/QueuedNotice';
import { useAuditRunning } from '@/lib/use-queue';

/**
 * Describe an audit in plain English. Prego reads it into settings and shows them for confirmation;
 * the audit starts only when someone presses Start audit.
 */
export function AuditAssistant() {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const plan = useMutation({ mutationFn: api.planAudit });
  const queryClient = useQueryClient();
  const running = useAuditRunning();
  const start = useMutation({
    mutationFn: api.startRun,
    onSuccess: (result) => {
      if (result.queued) void queryClient.invalidateQueries({ queryKey: ['queue'] });
      else navigate(`/runs/${result.runId}`);
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    start.reset();
    if (text.trim()) plan.mutate(text.trim());
  }

  // Open the full form with these settings filled in.
  function changeSettings(run: AuditPlan['run']) {
    const params = new URLSearchParams({ project: run.project, target: run.target, mode: run.mode, checks: run.checks.join(','), viewports: run.viewports.join(',') });
    const limit = run.maxStates ?? run.maxPages;
    if (limit) params.set('limit', String(limit));
    if (run.auditAll) params.set('all', '1');
    navigate(`/audits/new?${params}`);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-center text-3xl font-bold tracking-tight">What would you like to test?</h1>

      <form onSubmit={onSubmit} className="relative grid gap-3">
        <Label htmlFor="assistant-request" className="sr-only">
          Describe the audit
        </Label>
        <Textarea
          id="assistant-request"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="Run an accessibility audit on example.org"
          maxLength={1000}
          rows={1}
          className="min-h-0 resize-none rounded-2xl px-4 py-3.5 text-base shadow-[var(--shadow-card)] sm:pr-36"
        />
        <Button type="submit" className="justify-self-end sm:absolute sm:top-2 sm:right-2" disabled={plan.isPending || !text.trim()}>
          {plan.isPending ? 'Reading…' : 'Set up audit'}
        </Button>
        <p className="text-center text-xs text-muted-foreground">Describe the audit and Prego sets it up. You check the settings before anything starts.</p>
      </form>


      {plan.isError && (
        <Alert variant="destructive" role="alert">
          {plan.error.message}
        </Alert>
      )}
      <div aria-live="polite">{plan.data && <Confirmation plan={plan.data} onChange={() => changeSettings(plan.data.run)} onStart={() => start.mutate(plan.data.run)} starting={start.isPending} queues={running} queued={!!start.data?.queued} />}</div>
      {start.data?.queued && <QueuedNotice queued={start.data.queued} runningId={start.data.runId} />}
      {start.isError && (
        <Alert variant="destructive" role="alert">
          {start.error.message}
        </Alert>
      )}
    </div>
  );
}

function Confirmation({ plan, onStart, onChange, starting, queues, queued }: { plan: AuditPlan; onStart: () => void; onChange: () => void; starting: boolean; queues: boolean; queued: boolean }) {
  const { run } = plan;
  const limit = run.maxStates ?? run.maxPages;
  const noun = run.mode === 'explore' ? 'screens' : 'pages';
  const sizes = run.viewports.map((v) => PROFILES[v as ProfileName]?.label ?? v).join(', ');

  return (
    <section aria-labelledby="confirm-heading" className="space-y-4 rounded-2xl border bg-card p-5 shadow-[var(--shadow-card)]">
      <h2 id="confirm-heading" className="font-semibold">
        {plan.problems.length ? 'A bit more detail needed' : 'Check these settings'}
      </h2>
      {plan.problems.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {plan.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {plan.problems.length === 0 && (
        <>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="font-medium">Project</dt>
            <dd>
              {run.project} <span className="text-muted-foreground">({plan.projectExists ? 'existing project' : 'new project'})</span>
            </dd>
            <dt className="font-medium">Site</dt>
            <dd className="break-all">{run.target}</dd>
            <dt className="font-medium">Tests</dt>
            <dd>{plan.checksLabel}</dd>
            <dt className="font-medium">Screen sizes</dt>
            <dd>{sizes}</dd>
            <dt className="font-medium">{run.mode === 'explore' ? 'Screens' : 'Pages'}</dt>
            <dd>
              {run.mode === 'explore' ? `Explores by pressing controls, up to ${limit} ${noun}` : run.auditAll ? `Every page found, up to ${limit}` : `A sample of each template, up to ${limit} ${noun} found`}
            </dd>
          </dl>
          <p className="flex items-center gap-2 text-sm">
            <Clock aria-hidden="true" className="size-4 text-muted-foreground" /> Estimated time: {plan.estimate}
          </p>
          <p className="text-sm text-muted-foreground">
            Only audit sites you have permission to test. Prego runs passive checks only and follows the site’s robots.txt.
          </p>
        </>
      )}
      {plan.note && <p className="text-sm text-muted-foreground">{plan.note}</p>}
      <p className="text-xs text-muted-foreground">{plan.source === 'ollama' ? 'Read by the AI model running on this computer.' : 'Read by Prego’s built-in reader.'}</p>
      <div className="flex flex-wrap gap-3">
        {plan.problems.length === 0 && (
          <Button onClick={onStart} disabled={starting || queued}>
            {starting ? 'Starting…' : queued ? 'Queued' : queues ? 'Add to queue' : 'Start audit'}
          </Button>
        )}
        <Button variant="outline" onClick={onChange}>
          Change settings
        </Button>
      </div>
    </section>
  );
}
