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
  { value: 'explore', label: 'Interactive exploration', hint: 'Presses through single-page apps and kiosk interactives, mapping every screen it reaches.', available: true },
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
  return <NewAuditForm defaults={settings.data?.defaults} defaultDenyLabels={settings.data?.exploreDefaults.denyLabels ?? []} />;
}

function NewAuditForm({ defaults, defaultDenyLabels }: { defaults?: Settings['defaults']; defaultDenyLabels: string[] }) {
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
  const [mode, setMode] = useState<'crawl' | 'explore'>('crawl');
  const [maxStates, setMaxStates] = useState('200');
  const [exploreDepth, setExploreDepth] = useState('8');
  const [denyLabels, setDenyLabels] = useState(defaultDenyLabels.join('\n'));
  const [denySelectors, setDenySelectors] = useState('');
  const [masks, setMasks] = useState('');
  const [safetyEdited, setSafetyEdited] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const start = useMutation({
    mutationFn: api.startRun,
    onSuccess: ({ runId }) => navigate(`/runs/${runId}`),
  });

  // Offer the denylist and masks this project used last time, unless they've been edited here.
  function applyProjectSettings(name: string) {
    if (safetyEdited) return;
    const saved = projects.data?.find((p) => p.name.toLowerCase() === name.trim().toLowerCase())?.settings;
    setDenyLabels((saved?.denyLabels ?? defaultDenyLabels).join('\n'));
    setDenySelectors((saved?.denySelectors ?? []).join('\n'));
    setMasks((saved?.maskSelectors ?? []).join('\n'));
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const explore = mode === 'explore';
    const body: StartRunBody = {
      project: project.trim(),
      target: target.trim(),
      mode,
      viewports,
      emulation,
      maxPages: Number(maxPages),
      maxDepth: Number(explore ? exploreDepth : maxDepth),
      ...(explore && { maxStates: Number(maxStates), denyLabels: lines(denyLabels), denySelectors: lines(denySelectors), maskSelectors: lines(masks) }),
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
            <Input
              id="project"
              list="project-names"
              value={project}
              onChange={(e) => {
                setProject(e.target.value);
                if (mode === 'explore') applyProjectSettings(e.target.value);
              }}
              required
              autoComplete="off"
            />
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
            {MODES.map((option) => (
              <div key={option.value} className="flex items-start gap-2">
                <input
                  type="radio"
                  id={`mode-${option.value}`}
                  name="mode"
                  value={option.value}
                  checked={mode === option.value}
                  onChange={() => {
                    setMode(option.value as 'crawl' | 'explore');
                    if (option.value === 'explore') applyProjectSettings(project);
                  }}
                  disabled={!option.available}
                  aria-describedby={`mode-${option.value}-hint`}
                  className="mt-0.5 size-4 accent-primary"
                />
                <div className="grid gap-0.5">
                  <Label htmlFor={`mode-${option.value}`}>{option.label}</Label>
                  <span id={`mode-${option.value}-hint`} className="text-sm text-muted-foreground">
                    {option.hint}
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

      {mode === 'explore' && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Exploration limits</CardTitle>
              <CardDescription>Prego presses every control on every screen it finds, breadth-first, from the start screen.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5 sm:grid-cols-3">
              <Field id="max-states" label="Maximum screens">
                <Input id="max-states" type="number" min={1} max={2000} value={maxStates} onChange={(e) => setMaxStates(e.target.value)} required />
              </Field>
              <Field id="explore-depth" label="Maximum taps from the start">
                <Input id="explore-depth" type="number" min={0} value={exploreDepth} onChange={(e) => setExploreDepth(e.target.value)} required />
              </Field>
              <Field id="explore-time-budget" label="Time budget in minutes" hint="Optional.">
                <Input id="explore-time-budget" type="number" min={1} value={timeBudget} onChange={(e) => setTimeBudget(e.target.value)} />
              </Field>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Safety</CardTitle>
              <CardDescription>
                Prego never presses these, never follows links off the site and only types dummy data into forms. Remembered for this project.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5 sm:grid-cols-3">
              <Field id="deny-labels" label="Never press controls labelled" hint="One per line, matched as whole words.">
                <Textarea id="deny-labels" value={denyLabels} onChange={(e) => { setDenyLabels(e.target.value); setSafetyEdited(true); }} rows={6} />
              </Field>
              <Field id="deny-selectors" label="Never press elements matching" hint="CSS selectors, one per line, e.g. .admin-only">
                <Textarea id="deny-selectors" value={denySelectors} onChange={(e) => { setDenySelectors(e.target.value); setSafetyEdited(true); }} rows={6} />
              </Field>
              <Field id="mask-selectors" label="Ignore when telling screens apart" hint="CSS selectors for clocks, carousels or videos, one per line.">
                <Textarea id="mask-selectors" value={masks} onChange={(e) => { setMasks(e.target.value); setSafetyEdited(true); }} rows={6} />
              </Field>
            </CardContent>
          </Card>
        </>
      )}

      {mode === 'crawl' && (
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
      )}

      {mode === 'crawl' && (
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
      )}

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
