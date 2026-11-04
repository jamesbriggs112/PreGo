import { Children, cloneElement, isValidElement, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { PROFILES, isProfileName, type ProfileName } from '@prego/core/profiles';
import { estimateAudit, formatEstimate, groupChecks } from '@prego/core/estimate';
import { Clock } from 'lucide-react';
import { api, ApiError, type JourneySummary, type Settings, type StartRunBody } from '@/lib/api';
import { JourneyPicker } from '@/components/JourneyPicker';
import { useTitle } from '@/lib/use-title';
import { cn } from '@/lib/utils';
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
  { value: 'journey', label: 'Scripted journey', hint: 'Replays a journey you record once (such as booking a ticket), with checks after every step.', available: true },
];


// The form is split into steps so it isn't one long page. Every step can be revisited.
const STEPS = [
  { id: 'site', label: 'Site' },
  { id: 'sizes', label: 'Screen sizes' },
  { id: 'tests', label: 'Tests' },
  { id: 'scope', label: 'Scope and login' },
  { id: 'review', label: 'Review and start' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

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
  return <NewAuditForm defaults={settings.data?.defaults} defaultDenyLabels={settings.data?.exploreDefaults?.denyLabels ?? []} />;
}

function NewAuditForm({ defaults, defaultDenyLabels }: { defaults?: Settings['defaults']; defaultDenyLabels: string[] }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });

  const [project, setProject] = useState(params.get('project') ?? '');
  // The audit assistant on the first page passes its settings here to be changed.
  const listParam = (name: string) => params.get(name)?.split(',').filter(Boolean);
  const limitParam = params.get('limit');
  const [target, setTarget] = useState(params.get('target') ?? '');
  const [viewports, setViewports] = useState<ProfileName[]>((listParam('viewports')?.filter(isProfileName) ?? (defaults?.viewports as ProfileName[] | undefined)) ?? ['desktop']);
  const [emulation, setEmulation] = useState<Record<string, boolean>>({});
  const [maxPages, setMaxPages] = useState(params.get('mode') !== 'explore' && limitParam ? limitParam : '100');
  const [maxDepth, setMaxDepth] = useState('10');
  const [timeBudget, setTimeBudget] = useState('');
  const [perTemplate, setPerTemplate] = useState(String(defaults?.perTemplate ?? 3));
  const [auditAll, setAuditAll] = useState(params.get('all') === '1');
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [respectRobots, setRespectRobots] = useState(defaults?.respectRobots ?? true);
  const [useSitemap, setUseSitemap] = useState(true);
  const [concurrency, setConcurrency] = useState(String(defaults?.concurrency ?? 2));
  const [delay, setDelay] = useState(String(defaults?.delayMs ?? 500));
  const [mode, setMode] = useState<'crawl' | 'explore' | 'journey'>(params.get('mode') === 'explore' ? 'explore' : 'crawl');
  const checkList = useQuery({ queryKey: ['checks'], queryFn: api.checks });
  const checkGroups = useQuery({ queryKey: ['check-groups'], queryFn: api.checkGroups });
  const [checks, setChecks] = useState<string[]>(listParam('checks') ?? defaults?.checks ?? []);
  const [journey, setJourney] = useState<JourneySummary | null>(null);
  const [loginJourney, setLoginJourney] = useState<JourneySummary | null>(null);
  const [maxStates, setMaxStates] = useState(params.get('mode') === 'explore' && limitParam ? limitParam : '200');
  const [exploreDepth, setExploreDepth] = useState('8');
  const [denyLabels, setDenyLabels] = useState(defaultDenyLabels.join('\n'));
  const [denySelectors, setDenySelectors] = useState('');
  const [masks, setMasks] = useState('');
  const [safetyEdited, setSafetyEdited] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  // Settings handed over from the audit assistant open on the review step.
  const [step, setStep] = useState<StepId>(params.get('target') ? 'review' : 'site');
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) firstRender.current = false;
    else stepHeading.current?.focus();
  }, [step]);
  const stepIndex = STEPS.findIndex((s) => s.id === step);

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

  const problems: Partial<Record<StepId, string[]>> = {
    site: [
      ...(project.trim() ? [] : ['Enter a project name.']),
      ...(mode !== 'journey' && !target.trim() ? ['Enter the web address or folder to audit.'] : []),
      ...(mode === 'journey' && !journey ? ['Choose a recorded journey.'] : []),
    ],
    sizes: viewports.length ? [] : ['Choose at least one screen size.'],
    tests: checks.length ? [] : ['Choose at least one check.'],
  };
  const allProblems = STEPS.flatMap((s) => problems[s.id] ?? []);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    // Enter or Next moves on a step; only the last step starts the audit.
    if (step !== 'review') return setStep(STEPS[stepIndex + 1].id);
    const firstProblem = STEPS.find((s) => problems[s.id]?.length);
    if (firstProblem) return setStep(firstProblem.id);
    const explore = mode === 'explore';
    const body: StartRunBody = {
      project: project.trim(),
      // A journey starts where it was recorded.
      target: mode === 'journey' ? (journey?.startUrl ?? target.trim()) : target.trim(),
      mode,
      checks: checks.filter((id) => checkList.data?.find((c) => c.id === id)?.available ?? true),
      ...(mode === 'journey' && journey && { journey: journey.name }),
      ...(mode !== 'journey' && loginJourney && { loginJourney: loginJourney.name }),
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

      <nav aria-label="Audit set-up steps">
        <ol className="flex flex-wrap gap-2">
          {STEPS.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setStep(s.id)}
                aria-current={step === s.id ? 'step' : undefined}
                className={cn(
                  'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                  step === s.id ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted',
                )}
              >
                <span aria-hidden="true" className="tabular-nums">{i + 1}</span>
                {s.label}
                {s.id !== step && problems[s.id]?.length ? <span className="sr-only"> (needs attention)</span> : null}
                {s.id !== step && problems[s.id]?.length ? <span aria-hidden="true" className="size-2 rounded-full bg-destructive" /> : null}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <h2 ref={stepHeading} tabIndex={-1} className="text-lg font-semibold outline-none">
        Step {stepIndex + 1} of {STEPS.length}: {STEPS[stepIndex].label}
      </h2>

      {step === 'site' && (
      <>

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
          {mode !== 'journey' && (
            <Field id="target" label="Web address or folder" hint="A URL such as https://example.org, or the full path of a folder of HTML on this computer.">
              <Input id="target" value={target} onChange={(e) => setTarget(e.target.value)} required placeholder="https://" />
            </Field>
          )}
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
                    setMode(option.value as 'crawl' | 'explore' | 'journey');
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

      {mode === 'journey' && (
        <Card>
          <CardHeader>
            <CardTitle>Journey</CardTitle>
            <CardDescription>Prego replays the journey step by step and checks the page after every step, at each viewport.</CardDescription>
          </CardHeader>
          <CardContent>
            <JourneyPicker projectName={project} projects={projects.data} value={journey?.name ?? ''} onChange={setJourney} defaultUrl={target} legend="Journey to replay" />
          </CardContent>
        </Card>
      )}
      </>
      )}

      {step === 'sizes' && (
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
      )}

      {step === 'scope' && (
      <>
      {mode === 'journey' && <p className="text-muted-foreground">A journey follows its recorded steps, so there are no page limits to set.</p>}

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
          {mode !== 'journey' && (
            <div className="sm:col-span-2">
              <JourneyPicker
                projectName={project}
                projects={projects.data}
                value={loginJourney?.name ?? ''}
                onChange={setLoginJourney}
                defaultUrl={target}
                legend="Log in first with a recorded journey"
                optional
              />
            </div>
          )}
          <Field id="username" label="Username">
            <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
          </Field>
          <Field id="password" label="Password">
            <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
          </Field>
        </CardContent>
      </Card>
      </>
      )}

      {step === 'tests' && (

      <Card>
        <CardHeader>
          <CardTitle>Checks</CardTitle>
          <CardDescription>Pick a test group, or choose checks one by one. Starting choices come from Settings.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {checkList.data && checkGroups.data && (
            <fieldset>
              <legend className="mb-2 text-sm font-medium">Test group</legend>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {checkGroups.data.groups.map((group) => {
                  const ids = groupChecks(group, checkList.data.filter((c) => c.available));
                  const selected = ids.length === checks.length && ids.every((id) => checks.includes(id));
                  return (
                    <label
                      key={group.id}
                      className={cn(
                        'flex cursor-pointer flex-col gap-1 rounded-xl border p-3 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
                        selected ? 'border-primary bg-secondary' : 'hover:bg-muted',
                      )}
                    >
                      <span className="flex items-center gap-2 font-medium">
                        <input type="radio" name="check-group" className="sr-only" checked={selected} onChange={() => setChecks(ids)} aria-describedby={`group-${group.id}-hint`} />
                        {group.name}
                      </span>
                      <span id={`group-${group.id}-hint`} className="text-muted-foreground">
                        {group.description} {ids.length === 1 ? '1 check' : `${ids.length} checks`}.
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          )}
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="sr-only">Checks to run</legend>
            {checkList.data?.map((check) => (
              <div key={check.id} className="flex items-start gap-2">
                <Checkbox
                  id={`check-${check.id}`}
                  disabled={!check.available}
                  checked={checks.includes(check.id) && check.available}
                  onCheckedChange={(state) => setChecks((current) => (state === true ? [...current, check.id] : current.filter((c) => c !== check.id)))}
                  aria-describedby={`check-${check.id}-hint`}
                  className="mt-0.5"
                />
                <div className="grid gap-0.5">
                  <Label htmlFor={`check-${check.id}`}>{check.name}</Label>
                  <span id={`check-${check.id}-hint`} className="text-sm text-muted-foreground">
                    {check.description}
                    {check.slow && ' Adds several seconds per page.'}
                    {!check.available && (
                      <>
                        {' '}
                        <Link to="/settings" className="font-medium underline">
                          Switch it on in Settings
                        </Link>
                        .
                      </>
                    )}
                  </span>
                </div>
              </div>
            ))}
          </fieldset>
          {checks.length === 0 && (
            <p className="mt-2 text-sm text-destructive" role="alert">
              Choose at least one check.
            </p>
          )}
          {checkList.data && checks.length > 0 && (
            <TimeEstimate
              mode={mode}
              pages={mode === 'explore' ? Number(maxStates) : mode === 'journey' ? (journey?.steps.length ?? 5) : Number(maxPages)}
              viewports={Math.max(1, viewports.length)}
              auditAll={auditAll}
              perTemplate={Number(perTemplate) || 3}
              delayMs={Number(delay) || 0}
              concurrency={Number(concurrency) || 1}
              costs={checkList.data.filter((c) => checks.includes(c.id)).map((c) => c.cost)}
              calibration={checkGroups.data?.calibration ?? null}
            />
          )}
        </CardContent>
      </Card>
      )}

      {step === 'review' && (
        <Card>
          <CardHeader>
            <CardTitle>Check and start</CardTitle>
            <CardDescription>Nothing runs until you press Start audit.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {allProblems.length > 0 && (
              <Alert variant="destructive" role="alert">
                <ul className="list-disc space-y-1 pl-5">
                  {allProblems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </Alert>
            )}
            <dl className="divide-y rounded-xl border text-sm">
              {[
                { to: 'site' as const, term: 'Project', value: project.trim() || 'Not set' },
                { to: 'site' as const, term: mode === 'journey' ? 'Journey' : 'Site', value: mode === 'journey' ? (journey?.name ?? 'Not chosen') : target.trim() || 'Not set' },
                { to: 'site' as const, term: 'Mode', value: MODES.find((m) => m.value === mode)!.label },
                {
                  to: 'sizes' as const,
                  term: 'Screen sizes',
                  value: [viewports.map((v) => PROFILES[v].label).join(', ') || 'None', ...EMULATION.filter((e) => emulation[e.key]).map((e) => e.label.toLowerCase())].join('; '),
                },
                { to: 'tests' as const, term: 'Tests', value: testsSummary(checks, checkGroups.data?.groups ?? [], checkList.data ?? []) },
                {
                  to: 'scope' as const,
                  term: 'Scope',
                  value:
                    mode === 'explore'
                      ? `Up to ${maxStates} screens, ${exploreDepth} taps deep`
                      : mode === 'journey'
                        ? 'The recorded steps'
                        : `Up to ${maxPages} pages, ${auditAll ? 'every page audited' : `${perTemplate} per template audited`}, ${delay} ms between pages${respectRobots ? '' : ', ignoring robots.txt'}`,
                },
                { to: 'scope' as const, term: 'Login', value: loginJourney ? `Recorded journey “${loginJourney.name}”` : username ? `Basic auth as ${username}` : 'None' },
              ].map((row) => (
                <div key={row.term} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3">
                  <dt className="w-32 shrink-0 font-medium">{row.term}</dt>
                  <dd className="min-w-0 flex-1 break-words">{row.value}</dd>
                  <dd>
                    <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => setStep(row.to)}>
                      Change<span className="sr-only"> {row.term.toLowerCase()}</span>
                    </Button>
                  </dd>
                </div>
              ))}
            </dl>
            {checkList.data && checks.length > 0 && (
              <TimeEstimate
                mode={mode}
                pages={mode === 'explore' ? Number(maxStates) : mode === 'journey' ? (journey?.steps.length ?? 5) : Number(maxPages)}
                viewports={Math.max(1, viewports.length)}
                auditAll={auditAll}
                perTemplate={Number(perTemplate) || 3}
                delayMs={Number(delay) || 0}
                concurrency={Number(concurrency) || 1}
                costs={checkList.data.filter((c) => checks.includes(c.id)).map((c) => c.cost)}
                calibration={checkGroups.data?.calibration ?? null}
              />
            )}
          </CardContent>
        </Card>
      )}

      {step === 'review' && start.isError && (
        <Alert variant="destructive" role="alert">
          {start.error.message}{' '}
          {busyRunId && (
            <Link to={`/runs/${busyRunId}`} className="font-medium underline">
              Watch the running audit
            </Link>
          )}
        </Alert>
      )}

      <div className="flex flex-wrap gap-3">
        {stepIndex > 0 && (
          <Button type="button" variant="outline" size="lg" onClick={() => setStep(STEPS[stepIndex - 1].id)}>
            Back
          </Button>
        )}
        {step === 'review' ? (
          <Button type="submit" size="lg" disabled={start.isPending || allProblems.length > 0}>
            {start.isPending ? 'Starting…' : 'Start audit'}
          </Button>
        ) : (
          <Button type="submit" size="lg">
            Next: {STEPS[stepIndex + 1].label}
          </Button>
        )}
        <Button asChild variant="ghost" size="lg">
          <Link to="/">Cancel</Link>
        </Button>
      </div>
    </form>
  );
}

/** The test group's name when the checks match one exactly, otherwise the checks by name. */
function testsSummary(checks: string[], groups: { id: string; name: string }[], available: { id: string; name: string; available: boolean }[]): string {
  if (!checks.length) return 'None';
  const usable = available.filter((c) => c.available);
  const group = groups.find((g) => {
    const ids = groupChecks(g as Parameters<typeof groupChecks>[0], usable);
    return ids.length === checks.length && ids.every((id) => checks.includes(id));
  });
  if (group) return `${group.name} (${checks.length} ${checks.length === 1 ? 'check' : 'checks'})`;
  return available.filter((c) => checks.includes(c.id)).map((c) => c.name).join(', ');
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

function TimeEstimate(props: Omit<Parameters<typeof estimateAudit>[0], 'checks'> & { costs: Parameters<typeof estimateAudit>[0]['checks'] }) {
  const { costs, ...input } = props;
  const estimate = estimateAudit({ ...input, checks: costs });
  const noun = input.mode === 'explore' ? 'screens' : input.mode === 'journey' ? 'steps' : 'pages';
  const [lo, hi] = estimate.audited;
  return (
    <div className="flex items-start gap-3 rounded-xl bg-muted p-4 text-sm" aria-live="polite">
      <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="grid gap-0.5">
        <p className="font-medium">Estimated time: {formatEstimate(estimate)}</p>
        <p className="text-muted-foreground">
          {lo === hi ? `${lo} ${noun}` : `${lo}–${hi} ${noun} audited`} at {input.viewports === 1 ? '1 viewport' : `${input.viewports} viewports`}.{' '}
          {input.calibration
            ? `Based on ${input.calibration.runs === 1 ? '1 earlier audit' : `${input.calibration.runs} earlier audits`} on this computer; slow sites take longer.`
            : 'A rough guide for a typical live site. It gets more accurate once Prego has timed a few audits.'}
        </p>
      </div>
    </div>
  );
}
