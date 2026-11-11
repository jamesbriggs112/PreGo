import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_REPORT_OPTIONS, type OptionalSection, type ReportOptions, type ReportTextKey } from '@prego/core/report-options';
import { Link } from 'react-router';
import { Check, Eye, SlidersHorizontal, X } from 'lucide-react';
import { api, type PreviewReport, type ReportState, type RunDetail } from '@/lib/api';
import { CSV_PRESET_OPTIONS } from '@/lib/presets';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

// The Export page's report types: one card per report, ticked to put it in the export, with its own
// settings and preview. The developer report and its spreadsheets are always included, since every
// other report's ticket references point to them.

type ReportId = PreviewReport;

interface ReportType {
  id: ReportId;
  name: string;
  files: string;
  readers: string;
  about: string;
}

const REPORTS: ReportType[] = [
  {
    id: 'overview',
    name: 'Leadership summary',
    files: 'overview.docx',
    readers: 'Client leadership',
    about: 'A short read: scores at a glance, why a healthy website matters, key findings, top recommendations and a guide to the export.',
  },
  {
    id: 'client',
    name: 'Client report',
    files: 'client-report.docx',
    readers: 'The client team',
    about: 'Every issue grouped by theme and explained without ticket IDs, with your executive summary, methodology and conclusion.',
  },
  {
    id: 'technical',
    name: 'Developer report and tickets',
    files: 'report.docx, tickets.csv, occurrences.csv',
    readers: 'The development team',
    about: 'Every issue with its ticket ID, examples and fix, and spreadsheets ready to import into your issue tracker.',
  },
  {
    id: 'audience',
    name: 'Audience and tasks',
    files: 'audience.docx',
    readers: 'UX, strategy and content',
    about: 'What the site is for, who it serves, and whether each persona can do what they came to do.',
  },
  {
    id: 'future',
    name: 'Search and future readiness',
    files: 'future.docx',
    readers: 'Marketing and SEO',
    about: 'How the site looks in search results and when shared, and how ready it is for AI assistants and voice search.',
  },
];

const WRITTEN: Record<ReportTextKey, { label: string; hint: string; suggest?: 'keyFindings' | 'recommendations' | 'methodology'; rows: number }> = {
  summary: { label: 'Executive summary', hint: 'An introduction to the client, the site and the purpose of the audit. Leave blank to use Prego’s summary of the findings.', rows: 5 },
  keyFindings: { label: 'Key findings', hint: 'One per line. Leave blank to use the suggested findings. Shared by the leadership summary and the client report.', suggest: 'keyFindings', rows: 6 },
  recommendations: {
    label: 'Top recommendations',
    hint: 'One per line, most important first. Leave blank to use the suggested recommendations. Shared by the leadership summary and the client report.',
    suggest: 'recommendations',
    rows: 6,
  },
  methodology: { label: 'Methodology', hint: 'How the audit was done. Leave blank to use the suggested wording. The scope table follows it.', suggest: 'methodology', rows: 5 },
  conclusion: { label: 'Conclusion', hint: 'Optional. Leave blank to leave the Conclusion section out.', rows: 4 },
  whyItMatters: { label: 'Why a healthy website matters', hint: '', rows: 6 },
  analytics: { label: 'Your observations', hint: '', rows: 3 },
  content: { label: 'Your observations', hint: '', rows: 3 },
  ia: { label: 'Your observations', hint: '', rows: 3 },
  competitors: { label: 'Your observations', hint: '', rows: 3 },
  client: { label: 'Your observations', hint: '', rows: 3 },
  profile: { label: 'Your observations', hint: '', rows: 3 },
  audience: { label: 'Your observations', hint: 'Optional. Shown at the end of audience.docx.', rows: 4 },
  future: { label: 'Your observations', hint: 'Optional. Shown with the recommendations in future.docx.', rows: 4 },
};

const SECTIONS: { id: OptionalSection; label: string; hint: string }[] = [
  {
    id: 'client',
    label: 'About the client',
    hint: 'The background the team wrote on the project’s Client details page: the organisation, its goals, audiences and constraints. Contacts and internal notes are never included.',
  },
  {
    id: 'analytics',
    label: 'Analytics',
    hint: 'Traffic sources, devices, popular and landing pages, key events and countries from Google Analytics, what people search for from Search Console, and the issues on the busiest pages.',
  },
  { id: 'content', label: 'Content and tone', hint: 'Reading ease, sentence length and whether the copy talks to the reader.' },
  { id: 'ia', label: 'Information architecture', hint: 'How pages are organised: depth, top-level sections and the main navigation.' },
  {
    id: 'profile',
    label: 'Site profile and sustainability',
    hint: 'Page weight and estimated carbon, what the site is built with and hosted on, server country, certificate, accessibility statement and outside services.',
  },
  { id: 'competitors', label: 'Competitor analysis', hint: 'Lighthouse scores and home page screenshots for this site and its competitors.' },
];

/** Whether a report is in the export, as saved. */
function isChosen(id: ReportId, options: ReportOptions): boolean {
  if (id === 'technical') return true;
  if (id === 'client') return options.clientFacing;
  return options.reports[id];
}

/** Why a report can't be written for this audit, or null when it can. */
function missing(id: ReportId, state: ReportState | undefined, projectId: number): ReactNode {
  if (!state) return null;
  if (id === 'audience' && !state.hasAudience) {
    return (
      <>
        Needs personas and tasks: set them up on{' '}
        <Link to={`/projects/${projectId}/audience`} className="font-medium text-primary underline">
          Purposes and audience
        </Link>
        .
      </>
    );
  }
  if (id === 'future' && !state.hasReadiness) return 'Needs the Search and sharing or Future readiness check. Run the audit again with one ticked.';
  return null;
}

/** The reports in the export, chosen as cards, and the button that writes them. Choices save for this audit. */
export function ReportContents({ run }: { run: RunDetail }) {
  const queryClient = useQueryClient();
  const report = useQuery({ queryKey: ['report', run.id], queryFn: () => api.report(run.id) });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const [options, setOptions] = useState<ReportOptions | null>(null);
  const [open, setOpen] = useState<{ id: ReportId; view: 'customise' | 'preview' } | null>(null);
  const [preset, setPreset] = useState<string | null>(null);
  const current = options ?? report.data?.options ?? DEFAULT_REPORT_OPTIONS;
  const chosenPreset = preset ?? settings.data?.defaults.csvPreset ?? 'prego';

  const save = useMutation({
    mutationFn: (o: ReportOptions) => api.saveReport(run.id, o),
    onSuccess: (state) => {
      queryClient.setQueryData(['report', run.id], state);
      return queryClient.invalidateQueries({ queryKey: ['preview', run.id] });
    },
  });
  const create = useMutation({
    mutationFn: () => api.createExport(run.id, chosenPreset),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['exports', run.id] }),
  });

  // Text saves a moment after the last change, so typing doesn't send a request per key. Ticks save at once.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { mutate } = save;
  const pending = useRef<ReportOptions | null>(null);
  useEffect(() => {
    if (!pending.current) return;
    const next = pending.current;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => mutate(next), 600);
    return () => clearTimeout(timer.current);
  }, [options, mutate]);

  const update = (change: (o: ReportOptions) => ReportOptions, now = false) => {
    const next = change(current);
    setOptions(next);
    if (now) {
      pending.current = null;
      clearTimeout(timer.current);
      mutate(next);
    } else pending.current = next;
  };
  const setText = (key: ReportTextKey, value: string) => update((o) => ({ ...o, text: { ...o.text, [key]: value } }));
  const choose = (id: ReportId, on: boolean) =>
    update((o) => (id === 'client' ? { ...o, clientFacing: on } : id === 'technical' ? o : { ...o, reports: { ...o.reports, [id]: on } }), true);

  const included = REPORTS.filter((r) => isChosen(r.id, current) && !missing(r.id, report.data, run.projectId));
  const toggleOpen = (id: ReportId, view: 'customise' | 'preview') => setOpen((o) => (o?.id === id && o.view === view ? null : { id, view }));
  const shown = open ? REPORTS.find((r) => r.id === open.id)! : null;

  return (
    <div className="space-y-6">
      {report.isError && (
        <Alert variant="destructive" role="alert">
          {report.error.message}
        </Alert>
      )}
      <fieldset className="space-y-3">
        <legend className="mb-1 text-lg font-semibold">Reports in the export</legend>
        <p className="text-sm text-muted-foreground">Tick the reports you want. Each one is for a different reader; your choices are saved for this audit.</p>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {REPORTS.map((r) => {
            const why = missing(r.id, report.data, run.projectId);
            const on = isChosen(r.id, current) && !why;
            const always = r.id === 'technical';
            return (
              <div key={r.id} className={cn('flex flex-col gap-3 rounded-xl border p-4 transition-colors', on ? 'border-primary bg-secondary/40' : 'bg-card', why && 'border-dashed bg-muted/40')}>
                <div className="flex items-start gap-3">
                  <Checkbox
                    id={`report-${r.id}`}
                    checked={on}
                    disabled={always || !!why}
                    onCheckedChange={(state) => choose(r.id, state === true)}
                    aria-describedby={`report-${r.id}-hint`}
                    className="mt-1"
                  />
                  <div className="grid min-w-0 gap-1">
                    <Label htmlFor={`report-${r.id}`} className="text-base font-semibold">
                      {r.name}
                    </Label>
                    <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">For {r.readers.toLowerCase()}</p>
                  </div>
                </div>
                <div id={`report-${r.id}-hint`} className="grid flex-1 content-start gap-2 text-sm">
                  <p className="text-muted-foreground">{r.about}</p>
                  <p className="break-words font-mono text-xs text-muted-foreground">{r.files}</p>
                  {always && (
                    <p className="inline-flex items-center gap-1 font-medium">
                      <Check className="size-4" aria-hidden="true" /> Always included
                    </p>
                  )}
                  {why && <p className="font-medium">{why}</p>}
                </div>
                {!why && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => toggleOpen(r.id, 'customise')}
                      aria-expanded={open?.id === r.id && open.view === 'customise'}
                      aria-controls="report-panel"
                    >
                      <SlidersHorizontal aria-hidden="true" /> Customise<span className="sr-only"> {r.name}</span>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => toggleOpen(r.id, 'preview')}
                      aria-expanded={open?.id === r.id && open.view === 'preview'}
                      aria-controls="report-panel"
                      disabled={run.status !== 'complete'}
                    >
                      <Eye aria-hidden="true" /> Preview<span className="sr-only"> {r.name}</span>
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </fieldset>

      <div id="report-panel">
        {shown && open && (
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
              <div className="grid gap-1.5">
                <CardTitle>
                  {open.view === 'customise' ? 'Customise' : 'Preview'}: {shown.name}
                </CardTitle>
                <CardDescription>
                  {open.view === 'customise'
                    ? 'Changes save as you type.'
                    : `A simplified view of ${shown.files.split(',')[0]}. Layout and styling differ in Word.`}
                </CardDescription>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(null)}>
                <X aria-hidden="true" /> Close
              </Button>
            </CardHeader>
            <CardContent className="space-y-6">
              {open.view === 'preview' ? (
                <Preview runId={run.id} report={shown.id} />
              ) : (
                <Customise
                  id={shown.id}
                  options={current}
                  state={report.data}
                  whyItMatters={settings.data?.report.whyItMatters}
                  setText={setText}
                  include={(section, on) => update((o) => ({ ...o, include: { ...o.include, [section]: on } }), true)}
                  preset={chosenPreset}
                  setPreset={setPreset}
                  projectId={run.projectId}
                />
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Create the export</CardTitle>
          <CardDescription>
            {included.length === 1 ? '1 report' : `${included.length} reports`}: {included.map((r) => r.name).join(', ')}. The reports use the branding in{' '}
            <Link to="/settings" className="text-primary underline">
              Settings
            </Link>
            {settings.data ? ` (${settings.data.branding.companyName}${settings.data.hasLogo ? ', with logo' : ''})` : ''}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button size="lg" onClick={() => create.mutate()} disabled={create.isPending || save.isPending || run.status !== 'complete'}>
            {create.isPending ? 'Exporting…' : `Create export (${included.length} ${included.length === 1 ? 'report' : 'reports'})`}
          </Button>
          {create.isError && (
            <Alert variant="destructive" role="alert">
              {create.error.message}
            </Alert>
          )}
          <p role="status" className="text-sm">
            {create.isSuccess ? `Export ready: ${create.data.name}` : save.isPending ? 'Saving your choices…' : ''}
          </p>
          {save.isError && (
            <Alert variant="destructive" role="alert">
              {save.error.message}
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Customise(props: {
  id: ReportId;
  options: ReportOptions;
  state: ReportState | undefined;
  whyItMatters: string | undefined;
  setText: (key: ReportTextKey, value: string) => void;
  include: (section: OptionalSection, on: boolean) => void;
  preset: string;
  setPreset: (id: string) => void;
  projectId: number;
}) {
  const { id, options, state } = props;
  const text = (key: ReportTextKey, hint?: ReactNode) => (
    <WrittenField key={key} id={key} options={options} state={state} setText={props.setText} hint={hint} placeholder={key === 'whyItMatters' ? props.whyItMatters : undefined} />
  );
  const outline = (entries: ReportState['outline'] | undefined) =>
    entries && (
      <div className="text-sm">
        <p className="font-medium">Sections in this report</p>
        <p className="text-muted-foreground">{entries.map((o) => `${o.number}. ${o.title}`).join(' · ')}</p>
      </div>
    );

  if (id === 'overview') {
    return (
      <>
        {text('keyFindings')}
        {text('recommendations')}
        {text(
          'whyItMatters',
          <>
            Leave blank to use the standard wording from{' '}
            <Link to="/settings?section=report" className="text-primary underline">
              Settings
            </Link>
            , shown here faintly. Write your own to tailor it to this client.
          </>,
        )}
      </>
    );
  }
  if (id === 'client') {
    return (
      <>
        {(['summary', 'keyFindings', 'recommendations', 'methodology', 'conclusion'] as const).map((key) => text(key))}
        <ExtraSections {...props} />
        {outline(state?.clientOutline)}
      </>
    );
  }
  if (id === 'technical') {
    return (
      <>
        <fieldset className="grid gap-3">
          <legend className="mb-1 text-sm font-medium">tickets.csv columns for</legend>
          {CSV_PRESET_OPTIONS.map((option) => (
            <div key={option.id} className="flex items-start gap-2">
              <input
                type="radio"
                id={`preset-${option.id}`}
                name="preset"
                value={option.id}
                checked={props.preset === option.id}
                onChange={() => props.setPreset(option.id)}
                aria-describedby={`preset-${option.id}-hint`}
                className="mt-0.5 size-4 accent-primary"
              />
              <div className="grid gap-0.5">
                <Label htmlFor={`preset-${option.id}`}>{option.label}</Label>
                <span id={`preset-${option.id}-hint`} className="text-sm text-muted-foreground">
                  {option.hint}
                </span>
              </div>
            </div>
          ))}
        </fieldset>
        <ExtraSections {...props} />
        {outline(state?.outline)}
      </>
    );
  }
  return text(id);
}

/** The optional sections, shared by the developer and client reports. */
function ExtraSections({ options, state, include, setText, projectId }: Parameters<typeof Customise>[0]) {
  const why: Record<OptionalSection, ReactNode> = {
    analytics: (
      <>
        Import Google Analytics or Search Console exports on the project’s{' '}
        <Link to={`/projects/${projectId}/audience`} className="text-primary underline">
          Purposes and audience
        </Link>{' '}
        page to use this.
      </>
    ),
    content: 'Needs the “Content and structure (for reports)” check in the audit. Run the audit again with it ticked.',
    ia: 'Available for site crawls only.',
    client: (
      <>
        Add the client’s background on the project’s{' '}
        <Link to={`/projects/${projectId}/client`} className="text-primary underline">
          Client details
        </Link>{' '}
        page to use this.
      </>
    ),
    profile: 'Run the audit again to collect the site profile.',
    competitors: 'Add competitor sites in the Scope and login step of the New audit form, then run the audit again.',
  };
  return (
    <fieldset className="grid gap-3">
      <legend className="mb-1 text-sm font-medium">Extra sections</legend>
      <p className="text-sm text-muted-foreground">Shared by the developer report and the client report.</p>
      {SECTIONS.map((section) => {
        const has = state?.available[section.id] ?? false;
        const on = options.include[section.id];
        return (
          <div key={section.id} className="grid gap-2 rounded-xl border p-4">
            <div className="flex items-start gap-2">
              <Checkbox
                id={`section-${section.id}`}
                checked={on}
                onCheckedChange={(value) => include(section.id, value === true)}
                aria-describedby={`section-${section.id}-hint`}
                className="mt-0.5"
              />
              <div className="grid gap-0.5">
                <Label htmlFor={`section-${section.id}`}>{section.label}</Label>
                <span id={`section-${section.id}-hint`} className="text-sm text-muted-foreground">
                  {section.hint} {!has && why[section.id]}
                </span>
              </div>
            </div>
            {on && has && (
              <div className="pl-6">
                <WrittenField id={section.id} options={options} state={state} setText={setText} hint="Optional. Shown after Prego’s figures." />
              </div>
            )}
            {on && !has && <p className="pl-6 text-sm text-muted-foreground">Left out of the report until there’s something to show.</p>}
          </div>
        );
      })}
    </fieldset>
  );
}

function WrittenField({
  id,
  options,
  state,
  setText,
  hint,
  placeholder,
}: {
  id: ReportTextKey;
  options: ReportOptions;
  state: ReportState | undefined;
  setText: (key: ReportTextKey, value: string) => void;
  hint?: ReactNode;
  placeholder?: string;
}) {
  const w = WRITTEN[id];
  const suggestion = w.suggest && state ? state.suggestions[w.suggest] : undefined;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor={`report-text-${id}`}>{w.label}</Label>
        {suggestion && (
          <Button type="button" variant="outline" size="sm" onClick={() => setText(id, suggestion)}>
            Fill in the suggestion<span className="sr-only"> for {w.label.toLowerCase()}</span>
          </Button>
        )}
      </div>
      <span id={`report-text-${id}-hint`} className="text-sm text-muted-foreground">
        {hint ?? w.hint}
      </span>
      <Textarea
        id={`report-text-${id}`}
        aria-describedby={`report-text-${id}-hint`}
        rows={w.rows}
        value={options.text[id] ?? ''}
        placeholder={placeholder ?? suggestion}
        onChange={(e) => setText(id, e.target.value)}
      />
    </div>
  );
}

function Preview({ runId, report }: { runId: number; report: ReportId }) {
  const preview = useQuery({ queryKey: ['preview', runId, report], queryFn: () => api.reportPreview(runId, report), staleTime: 0, gcTime: 0 });
  return (
    <>
      {preview.isPending && <p role="status">Building the preview…</p>}
      {preview.isError && (
        <Alert variant="destructive" role="alert">
          {preview.error.message}
        </Alert>
      )}
      {preview.data && (
        // Sandboxed with no permissions: the preview can't run scripts or navigate.
        <iframe
          title="Report preview"
          sandbox=""
          srcDoc={`<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#222;line-height:1.5}img{max-width:100%;height:auto;border:1px solid #ddd}table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid #bbb;padding:4px 8px;text-align:left;vertical-align:top}h1,h2{color:#1f3a5f}</style></head><body>${preview.data.html}</body></html>`}
          className="h-[70vh] w-full rounded-md border bg-white"
        />
      )}
    </>
  );
}
