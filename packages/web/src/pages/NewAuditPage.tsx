import { Children, cloneElement, isValidElement, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { PROFILES, type ProfileName } from '@prego/core/profiles';
import { api, ApiError, type Settings, type StartRunBody } from '@/lib/api';
import { useTitle } from '@/lib/use-title';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const EMULATION = [
  { key: 'reducedMotion', label: 'Reduced motion' },
  { key: 'forcedColors', label: 'Forced colours (high contrast)' },
  { key: 'darkMode', label: 'Dark mode' },
  { key: 'zoom200', label: '200% zoom' },
] as const;

const MODES = [
  { value: 'crawl', label: 'Site crawl', hint: 'Follows the sitemap and links. For websites and multi-page builds.', available: true },
  { value: 'explore', label: 'Interactive exploration', hint: 'Taps through single-page apps and kiosk interactives. Coming in Phase 3.', available: false },
  { value: 'journey', label: 'Scripted journey', hint: 'Replays a recorded journey. Coming in Phase 3.', available: false },
];

const CHECKS = [
  { label: 'Accessibility (axe-core, WCAG 2.2 A and AA)', available: true },
  { label: 'Custom accessibility checks (keyboard, reflow, zoom)', available: false },
  { label: 'UI consistency', available: false },
  { label: 'Content and SEO', available: false },
  { label: 'Performance (Lighthouse)', available: false },
  { label: 'Security headers', available: false },
  { label: 'HTML validity', available: false },
];

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

export function NewAuditPage() {
  useTitle('New audit');
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  if (settings.isPending) return <p>Loading…</p>;
  // Fall back to built-in defaults if settings can't be loaded; the form still works.
  return <NewAuditForm defaults={settings.data?.defaults} />;
}

function NewAuditForm({ defaults }: { defaults?: Settings['defaults'] }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });

  const [project, setProject] = useState(params.get('project') ?? '');
  const [target, setTarget] = useState('');
  const [viewports, setViewports] = useState<ProfileName[]>((defaults?.viewports as ProfileName[] | undefined) ?? ['desktop']);
  const [emulation, setEmulation] = useState<Record<string, boolean>>({});
  const [maxPages, setMaxPages] = useState('100');
  const [maxDepth, setMaxDepth] = useState('10');
  const [timeBudget, setTimeBudget] = useState('');
  const [perTemplate, setPerTemplate] = useState(String(defaults?.perTemplate ?? 3));
  const [auditAll, setAuditAll] = useState(false);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [respectRobots, setRespectRobots] = useState(defaults?.respectRobots ?? true);
  const [useSitemap, setUseSitemap] = useState(true);
  const [concurrency, setConcurrency] = useState(String(defaults?.concurrency ?? 2));
  const [delay, setDelay] = useState(String(defaults?.delayMs ?? 500));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const start = useMutation({
    mutationFn: api.startRun,
    onSuccess: ({ runId }) => navigate(`/runs/${runId}`),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const body: StartRunBody = {
      project: project.trim(),
      target: target.trim(),
      viewports,
      emulation,
      maxPages: Number(maxPages),
      maxDepth: Number(maxDepth),
      timeBudgetMinutes: timeBudget ? Number(timeBudget) : undefined,
      perTemplate: Number(perTemplate),
      auditAll,
      include: lines(include),
      exclude: lines(exclude),
      respectRobots,
      useSitemap,
      concurrency: Number(concurrency),
      delayMs: Number(delay),
      basicAuth: username ? { username, password } : undefined,
    };
    start.mutate(body);
  }

  const toggleViewport = (name: ProfileName, on: boolean) =>
    setViewports((current) => (on ? [...current, name] : current.filter((v) => v !== name)).sort((a, b) => Object.keys(PROFILES).indexOf(a) - Object.keys(PROFILES).indexOf(b)));

  const busyRunId = start.error instanceof ApiError && start.error.status === 409 ? (start.error.body.runId as number) : undefined;

  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate={false}>
      <div>
        <h1 className="text-2xl font-bold">New audit</h1>
        <p className="text-muted-foreground">Prego explores the target, checks every page it reaches and builds a report and tickets.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>What to audit</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5">
          <Field id="project" label="Project" hint="Choose an existing project or type a new name.">
            <Input id="project" list="project-names" value={project} onChange={(e) => setProject(e.target.value)} required autoComplete="off" />
            <datalist id="project-names">
              {projects.data?.map((p) => (
                <option key={p.id} value={p.name} />
              ))}
            </datalist>
          </Field>
          <Field id="target" label="Web address or folder" hint="A URL such as https://example.org, or the full path of a folder of HTML on this computer.">
            <Input id="target" value={target} onChange={(e) => setTarget(e.target.value)} required placeholder="https://" />
          </Field>
          <fieldset className="grid gap-3">
            <legend className="mb-1 text-sm font-medium">Exploration mode</legend>
            {MODES.map((mode) => (
              <div key={mode.value} className="flex items-start gap-2">
                <input
                  type="radio"
                  id={`mode-${mode.value}`}
                  name="mode"
                  value={mode.value}
                  defaultChecked={mode.value === 'crawl'}
                  disabled={!mode.available}
                  aria-describedby={`mode-${mode.value}-hint`}
                  className="mt-0.5 size-4 accent-primary"
                />
                <div className="grid gap-0.5">
                  <Label htmlFor={`mode-${mode.value}`}>{mode.label}</Label>
                  <span id={`mode-${mode.value}-hint`} className="text-sm text-muted-foreground">
                    {mode.hint}
                  </span>
                </div>
              </div>
            ))}
          </fieldset>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Viewports</CardTitle>
          <CardDescription>Every audited page is checked at each viewport you choose.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Screen sizes</legend>
            {(Object.values(PROFILES) as (typeof PROFILES)[ProfileName][]).map((profile) => (
              <CheckboxField
                key={profile.name}
                id={`viewport-${profile.name}`}
                checked={viewports.includes(profile.name)}
                onChange={(on) => toggleViewport(profile.name, on)}
                label={`${profile.label} (${profile.width}×${profile.height}${profile.touch ? ', touch' : ''})`}
              />
            ))}
          </fieldset>
          <fieldset className="grid gap-2 content-start">
            <legend className="mb-1 text-sm font-medium">Emulation</legend>
            {EMULATION.map((option) => (
              <CheckboxField
                key={option.key}
                id={`emulation-${option.key}`}
                checked={!!emulation[option.key]}
                onChange={(on) => setEmulation((current) => ({ ...current, [option.key]: on }))}
                label={option.label}
              />
            ))}
          </fieldset>
          {viewports.length === 0 && (
            <p className="text-sm text-destructive sm:col-span-2" role="alert">
              Choose at least one screen size.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Scope</CardTitle>
          <CardDescription>Limits keep runs fast. Pages built from the same template are sampled.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          <Field id="max-pages" label="Maximum pages">
            <Input id="max-pages" type="number" min={1} max={5000} value={maxPages} onChange={(e) => setMaxPages(e.target.value)} required />
          </Field>
          <Field id="max-depth" label="Maximum link depth">
            <Input id="max-depth" type="number" min={0} value={maxDepth} onChange={(e) => setMaxDepth(e.target.value)} required />
          </Field>
          <Field id="time-budget" label="Time budget in minutes" hint="Optional. Stops discovering new pages after this long.">
            <Input id="time-budget" type="number" min={1} value={timeBudget} onChange={(e) => setTimeBudget(e.target.value)} />
          </Field>
          <Field id="per-template" label="Pages audited per template">
            <Input id="per-template" type="number" min={1} value={perTemplate} onChange={(e) => setPerTemplate(e.target.value)} disabled={auditAll} required />
          </Field>
          <div className="sm:col-span-2">
            <CheckboxField id="audit-all" checked={auditAll} onChange={setAuditAll} label="Audit every page, not a sample per template" />
          </div>
          <Field id="include" label="Only include addresses matching" hint="One pattern per line, e.g. /blog/**. Leave empty to include the whole site.">
            <Textarea id="include" value={include} onChange={(e) => setInclude(e.target.value)} rows={3} />
          </Field>
          <Field id="exclude" label="Exclude addresses matching" hint="One pattern per line, e.g. /search/**.">
            <Textarea id="exclude" value={exclude} onChange={(e) => setExclude(e.target.value)} rows={3} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Crawl politeness</CardTitle>
          <CardDescription>Defaults keep load on the client’s site low.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          <Field id="concurrency" label="Pages open at once">
            <Input id="concurrency" type="number" min={1} max={8} value={concurrency} onChange={(e) => setConcurrency(e.target.value)} required />
          </Field>
          <Field id="delay" label="Delay between pages (milliseconds)">
            <Input id="delay" type="number" min={0} value={delay} onChange={(e) => setDelay(e.target.value)} required />
          </Field>
          <CheckboxField id="robots" checked={respectRobots} onChange={setRespectRobots} label="Respect robots.txt (turn off only for staging sites you own)" />
          <CheckboxField id="sitemap" checked={useSitemap} onChange={setUseSitemap} label="Start from sitemap.xml as well as links" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Login</CardTitle>
          <CardDescription>For staging sites behind basic auth. Credentials are used for this audit only and never saved.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          <Field id="username" label="Username">
            <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
          </Field>
          <Field id="password" label="Password">
            <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Checks</CardTitle>
          <CardDescription>More check modules arrive in Phase 4.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2">
            {CHECKS.map((check) => (
              <li key={check.label} className="flex items-center gap-2 text-sm">
                <span className={check.available ? 'font-medium' : 'text-muted-foreground'}>{check.label}</span>
                <span className="text-muted-foreground">{check.available ? '(on)' : '(not yet available)'}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {start.isError && (
        <Alert variant="destructive" role="alert">
          {start.error.message}{' '}
          {busyRunId && (
            <Link to={`/runs/${busyRunId}`} className="font-medium underline">
              Watch the running audit
            </Link>
          )}
        </Alert>
      )}

      <div className="flex gap-3">
        <Button type="submit" size="lg" disabled={start.isPending || viewports.length === 0}>
          {start.isPending ? 'Starting…' : 'Start audit'}
        </Button>
        <Button asChild variant="ghost" size="lg">
          <Link to="/">Cancel</Link>
        </Button>
      </div>
    </form>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid gap-2 content-start">
      <Label htmlFor={id}>{label}</Label>
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      <HintedControl hintId={hint ? `${id}-hint` : undefined}>{children}</HintedControl>
    </div>
  );
}

/** Links the first form control to its hint with aria-describedby. */
function HintedControl({ hintId, children }: { hintId?: string; children: ReactNode }) {
  if (!hintId) return <>{children}</>;
  return (
    <>
      {Children.toArray(children).map((child, i) =>
        i === 0 && isValidElement<{ 'aria-describedby'?: string }>(child) ? cloneElement(child, { 'aria-describedby': hintId }) : child,
      )}
    </>
  );
}

function CheckboxField({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(state) => onChange(state === true)} />
      <Label htmlFor={id} className="font-normal leading-snug">
        {label}
      </Label>
    </div>
  );
}
