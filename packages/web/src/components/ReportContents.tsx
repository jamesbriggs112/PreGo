import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_REPORT_OPTIONS, type OptionalSection, type ReportOptions, type ReportTextKey } from '@prego/core/report-options';
import { Link } from 'react-router';
import { api, type RunDetail } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** `overview`: also used by the Overview report, so shown whenever the Overview is in the pack. */
const WRITTEN: { key: ReportTextKey; label: string; hint: string; suggest?: 'keyFindings' | 'recommendations' | 'methodology'; rows: number; overview?: boolean }[] = [
  { key: 'summary', label: 'Executive summary', hint: 'An introduction to the client, the site and the purpose of the audit. Leave blank to use Prego’s summary of the findings.', rows: 5 },
  { key: 'keyFindings', label: 'Key findings', hint: 'One per line. Leave blank to use the suggested findings.', suggest: 'keyFindings', rows: 6, overview: true },
  { key: 'recommendations', label: 'Top recommendations', hint: 'One per line, most important first. Leave blank to use the suggested recommendations.', suggest: 'recommendations', rows: 6, overview: true },
  { key: 'methodology', label: 'Methodology', hint: 'How the audit was done. Leave blank to use the suggested wording. The scope table follows it.', suggest: 'methodology', rows: 5 },
  { key: 'conclusion', label: 'Conclusion', hint: 'Optional. Leave blank to leave the Conclusion section out.', rows: 4 },
];

const SECTIONS: { id: OptionalSection; label: string; hint: string; missing: string }[] = [
  { id: 'analytics', label: 'Analytics', hint: 'Traffic sources, devices, popular pages and countries from Google Analytics.', missing: 'Import Google Analytics CSV exports below to use this.' },
  { id: 'content', label: 'Content and tone', hint: 'Reading ease, sentence length and whether the copy talks to the reader.', missing: 'Needs the “Content and structure (for reports)” check in the audit. Run the audit again with it ticked.' },
  { id: 'ia', label: 'Information architecture', hint: 'How pages are organised: depth, top-level sections and the main navigation.', missing: 'Available for site crawls only.' },
  { id: 'competitors', label: 'Competitor analysis', hint: 'Lighthouse scores and home page screenshots for this site and its competitors.', missing: 'Add competitor sites in the Scope and login step of the New audit form, then run the audit again.' },
];

/** Choose what goes into report.docx. Changes save as you type. */
export function ReportContents({ run }: { run: RunDetail }) {
  const queryClient = useQueryClient();
  const report = useQuery({ queryKey: ['report', run.id], queryFn: () => api.report(run.id) });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const [options, setOptions] = useState<ReportOptions | null>(null);
  const current = options ?? report.data?.options ?? DEFAULT_REPORT_OPTIONS;
  const save = useMutation({
    mutationFn: (o: ReportOptions) => api.saveReport(run.id, o),
    onSuccess: (state) => {
      queryClient.setQueryData(['report', run.id], state);
      return queryClient.invalidateQueries({ queryKey: ['preview', run.id] });
    },
  });

  // Save a moment after the last change, so typing doesn't send a request per key.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { mutate } = save;
  useEffect(() => {
    if (!options) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => mutate(options), 600);
    return () => clearTimeout(timer.current);
  }, [options, mutate]);

  const update = (change: (o: ReportOptions) => ReportOptions) => setOptions(change(current));
  const setText = (key: ReportTextKey, value: string) => update((o) => ({ ...o, text: { ...o.text, [key]: value } }));
  const available = report.data?.available;
  const written = WRITTEN.filter((w) => current.clientFacing || (w.overview && current.reports.overview));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Report contents</CardTitle>
        <CardDescription>What goes into report.docx. Saved for this audit as you change it.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {report.isError && (
          <Alert variant="destructive" role="alert">
            {report.error.message}
          </Alert>
        )}
        <fieldset className="grid gap-3">
          <legend className="mb-1 text-sm font-medium">Reports in the pack</legend>
          <p className="text-sm text-muted-foreground">report.docx, the full findings with ticket IDs, is always included.</p>
          <Toggle
            id="report-overview"
            checked={current.reports.overview}
            onChange={(on) => update((o) => ({ ...o, reports: { ...o.reports, overview: on } }))}
            label="Overview (overview.docx)"
            hint="A short report for client leadership, read first: scores at a glance, why a healthy website matters, key findings, top recommendations and a guide to the pack."
          />
          <Toggle
            id="report-future"
            checked={current.reports.future}
            onChange={(on) => update((o) => ({ ...o, reports: { ...o.reports, future: on } }))}
            label="Search, sharing and future readiness (future.docx)"
            hint={
              <>
                How the site looks in search results and when shared on social media and in messages, with previews, and how ready it is for AI assistants, answer engines
                and voice search.
                {report.data && !report.data.hasReadiness && ' Needs the Search and sharing or Future readiness check in the audit. Run the audit again with them ticked.'}
              </>
            }
          />
          {current.reports.future && report.data?.hasReadiness && (
            <div className="grid gap-2 pl-6">
              <Label htmlFor="report-notes-future">Your observations</Label>
              <Textarea
                id="report-notes-future"
                rows={3}
                value={current.text.future ?? ''}
                onChange={(e) => setText('future', e.target.value)}
                placeholder="Optional. Shown with the recommendations in future.docx."
              />
            </div>
          )}
          {current.reports.overview && (
            <div className="grid gap-2 pl-6">
              <Label htmlFor="report-whyItMatters">Why a healthy website matters</Label>
              <span id="report-whyItMatters-hint" className="text-sm text-muted-foreground">
                Leave blank to use the standard wording from <Link to="/settings?section=report" className="text-primary underline">Settings</Link>, shown here
                faintly. Write your own to tailor it to this client.
              </span>
              <Textarea
                id="report-whyItMatters"
                aria-describedby="report-whyItMatters-hint"
                rows={6}
                value={current.text.whyItMatters ?? ''}
                placeholder={settings.data?.report.whyItMatters}
                onChange={(e) => setText('whyItMatters', e.target.value)}
              />
            </div>
          )}
        </fieldset>

        <Toggle
          id="client-facing"
          checked={current.clientFacing}
          onChange={(on) => update((o) => ({ ...o, clientFacing: on }))}
          label="Client-facing report"
          hint="Adds a contents page and your own executive summary, key findings, top recommendations, methodology and conclusion. Off gives the technical report for the development team."
        />

        {written.length > 0 && (
          <fieldset className="grid gap-5 rounded-xl border p-4">
            <legend className="px-1 text-sm font-medium">Written sections</legend>
            {written.map((w) => (
              <div key={w.key} className="grid gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label htmlFor={`report-${w.key}`}>{w.label}</Label>
                  {w.suggest && report.data && (
                    <Button type="button" variant="outline" size="sm" onClick={() => setText(w.key, report.data.suggestions[w.suggest!])}>
                      Fill in the suggestion<span className="sr-only"> for {w.label.toLowerCase()}</span>
                    </Button>
                  )}
                </div>
                <span id={`report-${w.key}-hint`} className="text-sm text-muted-foreground">
                  {w.hint}
                </span>
                <Textarea
                  id={`report-${w.key}`}
                  aria-describedby={`report-${w.key}-hint`}
                  rows={w.rows}
                  value={current.text[w.key] ?? ''}
                  placeholder={w.suggest && report.data ? report.data.suggestions[w.suggest] : undefined}
                  onChange={(e) => setText(w.key, e.target.value)}
                />
              </div>
            ))}
          </fieldset>
        )}

        <fieldset className="grid gap-4">
          <legend className="mb-1 text-sm font-medium">Optional sections</legend>
          {SECTIONS.map((section) => {
            const has = available?.[section.id] ?? false;
            const on = current.include[section.id];
            return (
              <div key={section.id} className="grid gap-2 rounded-xl border p-4">
                <Toggle
                  id={`section-${section.id}`}
                  checked={on}
                  onChange={(value) => update((o) => ({ ...o, include: { ...o.include, [section.id]: value } }))}
                  label={section.label}
                  hint={has ? section.hint : `${section.hint} ${section.missing}`}
                />
                {section.id === 'analytics' && <AnalyticsImport run={run} />}
                {on && has && (
                  <div className="grid gap-2 pl-6">
                    <Label htmlFor={`report-notes-${section.id}`}>Your observations</Label>
                    <Textarea
                      id={`report-notes-${section.id}`}
                      rows={3}
                      value={current.text[section.id] ?? ''}
                      onChange={(e) => setText(section.id, e.target.value)}
                      placeholder="Optional. Shown after Prego’s figures."
                    />
                  </div>
                )}
                {on && !has && <p className="pl-6 text-sm text-muted-foreground">Left out of the report until there’s something to show.</p>}
              </div>
            );
          })}
        </fieldset>

        {report.data && (
          <div className="text-sm">
            <p className="font-medium">Sections in the report</p>
            <p className="text-muted-foreground">{report.data.outline.map((o) => `${o.number}. ${o.title}`).join(' · ')}</p>
          </div>
        )}
        <p role="status" className="text-sm text-muted-foreground">
          {save.isPending ? 'Saving…' : save.isSuccess ? 'Saved.' : ''}
        </p>
        {save.isError && (
          <Alert variant="destructive" role="alert">
            {save.error.message}
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

function Toggle({ id, checked, onChange, label, hint }: { id: string; checked: boolean; onChange: (on: boolean) => void; label: string; hint: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(state) => onChange(state === true)} aria-describedby={`${id}-hint`} className="mt-0.5" />
      <div className="grid gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        <span id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </span>
      </div>
    </div>
  );
}

/** Import Google Analytics CSV exports for the project. They stay on this computer. */
function AnalyticsImport({ run }: { run: RunDetail }) {
  const queryClient = useQueryClient();
  const project = useQuery({ queryKey: ['project', run.projectId], queryFn: () => api.project(run.projectId) });
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['project', run.projectId] }), queryClient.invalidateQueries({ queryKey: ['report', run.id] })]);
  const upload = useMutation({ mutationFn: (files: { name: string; text: string }[]) => api.importAnalytics(run.projectId, files), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => api.removeAnalytics(run.projectId), onSuccess: refresh });
  const analytics = project.data?.settings.analytics;

  async function onFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    if (files.length) upload.mutate(await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() }))));
  }

  return (
    <div className="grid gap-2 pl-6 text-sm">
      {analytics && (
        <p>
          Imported {formatDateTime(analytics.importedAt)} from {analytics.files.join(', ')}
          {analytics.period ? `, covering ${analytics.period}` : ''}: {analytics.tables.map((t) => t.title.toLowerCase()).join(', ')}.
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1">
          <Label htmlFor="analytics-files">{analytics ? 'Replace with new exports' : 'Google Analytics CSV exports'}</Label>
          <input id="analytics-files" type="file" accept=".csv,text/csv" multiple onChange={onFiles} aria-describedby="analytics-files-hint" className="text-sm" />
        </div>
        {analytics && (
          <Button type="button" variant="outline" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
            Remove analytics
          </Button>
        )}
      </div>
      <span id="analytics-files-hint" className="text-muted-foreground">
        In Google Analytics, open Traffic acquisition, Pages and screens, Tech details or Demographic details, then Share → Download file → CSV. Shared by every audit of this
        project, and kept on this computer.
      </span>
      {upload.isPending && <p role="status">Importing…</p>}
      {(upload.isError || remove.isError) && (
        <Alert variant="destructive" role="alert">
          {(upload.error ?? remove.error)?.message}
        </Alert>
      )}
    </div>
  );
}
