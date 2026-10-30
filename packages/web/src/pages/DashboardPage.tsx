import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ClipboardList, FolderKanban, Plus, Radio, ScanSearch, ShieldAlert, Sparkles, TriangleAlert } from 'lucide-react';
import type { Severity } from '@prego/core/types';
import { api, type DashboardData } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { useTitle } from '@/lib/use-title';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RunStatusBadge } from '@/components/RunStatusBadge';
import { SeverityBadge } from '@/components/TicketBadges';
import { Heatmap, HistoryBars, ScoreRing, Sparkline } from '@/components/charts';

const MODE_LABELS = { crawl: 'Site crawl', explore: 'Interactive', journey: 'Journey' } as const;
const SEVERITIES: Severity[] = ['Critical', 'High', 'Medium', 'Low'];

export function DashboardPage() {
  useTitle('Dashboard');
  const dashboard = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard, refetchInterval: (q) => (q.state.data?.active ? 3000 : false) });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground">Your latest audits at a glance.</p>
        </div>
        <Button asChild size="lg">
          <Link to="/audits/new">
            <Plus aria-hidden="true" /> New audit
          </Link>
        </Button>
      </div>

      {dashboard.isPending && <p>Loading…</p>}
      {dashboard.isError && (
        <Alert variant="destructive" role="alert">
          Couldn’t load the dashboard: {dashboard.error.message}
        </Alert>
      )}
      {dashboard.data && (dashboard.data.totals.audits === 0 ? <EmptyDashboard /> : <Modules data={dashboard.data} />)}
    </div>
  );
}

function EmptyDashboard() {
  return (
    <Card className="overflow-hidden">
      <div className="grid gap-6 p-8 md:grid-cols-[1fr_auto] md:items-center">
        <div className="space-y-3">
          <Badge variant="brand">
            <Sparkles aria-hidden="true" className="size-3" /> Welcome to Prego
          </Badge>
          <h2 className="text-xl font-semibold">Run your first audit</h2>
          <p className="max-w-prose text-muted-foreground">
            Point Prego at a website, a kiosk interactive or a recorded journey. It checks every page or screen it reaches and builds a Word report and tickets for the team.
          </p>
        </div>
        <Button asChild size="lg">
          <Link to="/audits/new">
            Start an audit <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </Card>
  );
}

function Modules({ data }: { data: DashboardData }) {
  const history = data.history;
  const latest = data.latest;
  return (
    <div className="grid gap-5 lg:grid-cols-12">
      {/* Banner: a running audit, or a nudge to start one. */}
      <div className="lg:col-span-12">
        {data.active ? (
          <Link
            to={`/runs/${data.active.runId}`}
            className="flex items-center gap-3 rounded-xl border border-[var(--brand-200)] bg-[var(--brand-50)] px-4 py-3 text-sm hover:border-[var(--brand-300)]"
          >
            <Radio aria-hidden="true" className="size-5 shrink-0 animate-pulse text-primary" />
            <span>
              <span className="font-semibold">Audit in progress: {data.active.projectName}.</span> <span className="text-muted-foreground">Watch it live</span>
            </span>
            <ArrowRight aria-hidden="true" className="ml-auto size-4 text-primary" />
          </Link>
        ) : (
          <div className="flex items-center gap-3 rounded-xl border border-[var(--brand-200)] bg-[var(--brand-50)] px-4 py-3 text-sm">
            <ScanSearch aria-hidden="true" className="size-5 shrink-0 text-primary" />
            <span>
              <span className="font-semibold">Interactives and journeys are supported.</span>{' '}
              <span className="text-muted-foreground">Explore a kiosk screen by screen, or record a booking flow once and replay it with checks. </span>
              <Link to="/audits/new" className="font-medium text-primary underline underline-offset-2">
                Start one
              </Link>
            </span>
          </div>
        )}
      </div>

      {/* Latest audit */}
      {latest && (
        <Card className="lg:col-span-4">
          <CardHeader>
            <CardDescription>Latest audit</CardDescription>
            <CardTitle className="text-lg">{latest.projectName}</CardTitle>
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">{MODE_LABELS[latest.mode]}</Badge> {formatDateTime(latest.startedAt)}
            </p>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            <ScoreRing score={latest.scores.A11Y ?? null} label="Accessibility score" />
            <p className="text-sm text-muted-foreground">Accessibility score</p>
            <dl className="grid w-full grid-cols-3 gap-2 text-center">
              {(['UX', 'UI', 'SEC'] as const).map((c) => (
                <div key={c} className="rounded-lg bg-muted px-2 py-2">
                  <dt className="text-[11px] text-muted-foreground">{({ UX: 'Usability', UI: 'Visual', SEC: 'Security' } as const)[c]}</dt>
                  <dd className="text-lg font-semibold">{latest.scores[c] ?? '–'}</dd>
                </div>
              ))}
            </dl>
            <Button asChild variant="outline" className="w-full">
              <Link to={`/runs/${latest.runId}`}>View results</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* KPI tiles */}
      <div className="grid gap-5 sm:grid-cols-2 lg:col-span-8">
        <Kpi
          icon={<ClipboardList aria-hidden="true" />}
          label="Open tickets"
          value={data.totals.openTickets}
          hint="Across each project’s latest audit"
          trend={history.map((h) => h.tickets)}
          trendLabel="Open tickets per audit, oldest to newest"
        />
        <Kpi
          icon={<TriangleAlert aria-hidden="true" />}
          label="Critical issues"
          value={data.totals.critical}
          hint="Blocking problems to fix first"
          trend={history.map((h) => h.critical)}
          trendLabel="Critical tickets per audit, oldest to newest"
          tone="critical"
        />
        <Kpi
          icon={<ShieldAlert aria-hidden="true" />}
          label="Accessibility score"
          value={latest?.scores.A11Y ?? '–'}
          suffix={latest?.scores.A11Y !== undefined ? '/ 100' : undefined}
          hint="An indicator, not a compliance measure"
          trend={history.map((h) => h.a11y).filter((v): v is number => v !== null)}
          trendLabel="Accessibility score per audit, oldest to newest"
        />
        <Kpi icon={<FolderKanban aria-hidden="true" />} label="Projects" value={data.totals.projects} hint={`${data.totals.audits} audits in total`} link={{ to: '/projects', label: 'All projects' }} />
      </div>

      {/* Issues by category and severity */}
      <Card className="lg:col-span-5">
        <CardHeader>
          <CardTitle>Issues by category</CardTitle>
          <CardDescription>Open tickets in each project’s latest audit</CardDescription>
        </CardHeader>
        <CardContent>
          <Heatmap
            rows={data.heatmap.categories}
            columns={SEVERITIES}
            cells={data.heatmap.cells.map((c) => ({ row: c.category, column: c.severity, value: c.count }))}
            label="Open tickets by category and severity"
          />
        </CardContent>
      </Card>

      {/* Top issues */}
      <Card className="lg:col-span-4">
        <CardHeader>
          <CardTitle>Fix these first</CardTitle>
          <CardDescription>Highest-priority open tickets</CardDescription>
        </CardHeader>
        <CardContent>
          {data.topIssues.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open tickets.</p>
          ) : (
            <ol className="space-y-1">
              {data.topIssues.map((t, i) => (
                <li key={`${t.runId}-${t.ticketId}`}>
                  <Link to={`/runs/${t.runId}/tickets/${t.ticketId}`} className={`flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-muted ${i === 0 ? 'bg-[var(--brand-50)]' : ''}`}>
                    <span className="w-6 shrink-0 pt-0.5 text-xs font-semibold text-muted-foreground">#{i + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{t.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {t.ticketId} · {t.projectName} · {t.occurrences} {t.occurrences === 1 ? 'occurrence' : 'occurrences'}
                      </span>
                    </span>
                    <SeverityBadge severity={t.severity} />
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      {/* Recent audits */}
      <Card className="lg:col-span-3">
        <CardHeader>
          <CardTitle>Recent audits</CardTitle>
          <CardDescription>
            <Link to="/projects" className="text-primary underline-offset-2 hover:underline">
              All projects
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1">
            {data.recentRuns.map((r) => (
              <li key={r.id}>
                <Link to={`/runs/${r.id}`} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-muted">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{r.projectName}</span>
                    <span className="block text-xs text-muted-foreground">{formatDateTime(r.startedAt)}</span>
                  </span>
                  <RunStatusBadge status={r.status} />
                </Link>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Audit history */}
      {history.length > 0 && (
        <Card className="lg:col-span-12">
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>Audit history</CardTitle>
              <CardDescription>Open tickets found by each completed audit</CardDescription>
            </div>
            <div className="flex gap-6 text-right">
              <Stat label="Audits" value={history.length} />
              <Stat label="Average tickets" value={Math.round(history.reduce((s, h) => s + h.tickets, 0) / history.length)} />
            </div>
          </CardHeader>
          <CardContent>
            <HistoryBars
              bars={history.map((h) => ({ key: h.runId, label: `#${h.runId}`, value: h.tickets, detail: `${h.projectName}, ${formatDateTime(h.startedAt)}` }))}
              label="Open tickets per audit"
              unit="tickets"
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  suffix,
  hint,
  trend,
  trendLabel,
  tone,
  link,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  suffix?: string;
  hint: string;
  trend?: number[];
  trendLabel?: string;
  tone?: 'critical';
  link?: { to: string; label: string };
}) {
  return (
    <Card className="flex flex-col justify-between">
      <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
        <Badge variant={tone === 'critical' ? 'critical-soft' : 'brand'} className="gap-1.5 [&_svg]:size-3.5">
          {icon}
          {label}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-3xl font-bold tracking-tight">
              {value}
              {suffix && <span className="ml-1 text-base font-normal text-muted-foreground">{suffix}</span>}
            </p>
            <p className="text-xs text-muted-foreground">{hint}</p>
          </div>
          {link && (
            <Link to={link.to} className="text-sm font-medium text-primary underline-offset-2 hover:underline">
              {link.label}
            </Link>
          )}
        </div>
        {trend && trendLabel && <Sparkline values={trend} label={trendLabel} className={tone === 'critical' ? 'text-[var(--critical-500)]' : undefined} />}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}
