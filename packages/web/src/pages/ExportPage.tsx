import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, FileArchive } from 'lucide-react';
import { api, exportFileUrl, exportZipUrl, type ExportSummary, type PreviewReport } from '@/lib/api';
import { CSV_PRESET_OPTIONS } from '@/lib/presets';
import { useTitle } from '@/lib/use-title';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ReportContents } from '@/components/ReportContents';

const FILE_LABELS: Record<string, string> = {
  'overview.docx': 'Overview (Word)',
  'audience.docx': 'Audience and tasks (Word)',
  'future.docx': 'Search, sharing and future readiness (Word)',
  'report.docx': 'Full findings report (Word)',
  'tickets.csv': 'Tickets (CSV)',
  'occurrences.csv': 'Occurrences (CSV)',
  'run.json': 'Raw data (JSON)',
  'state-map.png': 'State map (PNG)',
};

export function ExportPage() {
  const runId = Number(useParams().runId);
  const queryClient = useQueryClient();
  const run = useQuery({ queryKey: ['run', runId], queryFn: () => api.run(runId) });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const exports = useQuery({ queryKey: ['exports', runId], queryFn: () => api.exports(runId) });
  const [preset, setPreset] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewing, setPreviewing] = useState<PreviewReport>('technical');
  const report = useQuery({ queryKey: ['report', runId], queryFn: () => api.report(runId) });
  const choices: { id: PreviewReport; label: string; file: string }[] = [
    ...(report.data?.options.reports.overview ? [{ id: 'overview' as const, label: 'Overview', file: 'overview.docx' }] : []),
    ...(report.data?.options.reports.audience && report.data.hasAudience ? [{ id: 'audience' as const, label: 'Audience and tasks', file: 'audience.docx' }] : []),
    ...(report.data?.options.reports.future && report.data.hasReadiness ? [{ id: 'future' as const, label: 'Search, sharing and future readiness', file: 'future.docx' }] : []),
    { id: 'technical', label: 'Full findings report', file: 'report.docx' },
  ];
  const shown = choices.find((c) => c.id === previewing)?.id ?? 'technical';
  const preview = useQuery({ queryKey: ['preview', runId, shown], queryFn: () => api.reportPreview(runId, shown), enabled: showPreview, staleTime: 0, gcTime: 0 });
  useTitle(run.data ? `Export ${run.data.project.name}` : 'Export');

  const chosenPreset = preset ?? settings.data?.defaults.csvPreset ?? 'prego';
  const create = useMutation({
    mutationFn: () => api.createExport(runId, chosenPreset),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['exports', runId] }),
  });

  const [latest, ...older] = exports.data ?? [];

  return (
    <div className="space-y-6">
      <Link to={`/runs/${runId}`} className="inline-flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> Back to results
      </Link>
      <div>
        <h1 className="text-2xl font-bold">Export{run.data ? ` ${run.data.project.name}` : ''}</h1>
        <p className="text-muted-foreground">
          One folder with the Word reports, tickets.csv and occurrences.csv, all cross-referenced by ticket ID. Dismissed tickets are left out.
        </p>
      </div>

      {run.data && (
        <Alert role="note">
          {run.data.screenshotsDeleted
            ? 'This audit’s screenshots were deleted when it was first exported, so a new export’s report won’t have any. The earlier report still has them.'
            : 'Exporting puts the screenshots into the Word report and then deletes them from Prego. To keep them, keep the report.'}
        </Alert>
      )}

      {run.data && <ReportContents run={run.data} />}

      <Card>
        <CardHeader>
          <CardTitle>Create an export</CardTitle>
          <CardDescription>
            The report uses the branding in <Link to="/settings" className="text-primary underline">Settings</Link>
            {settings.data ? ` (${settings.data.branding.companyName}${settings.data.hasLogo ? ', with logo' : ''})` : ''}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <fieldset className="grid gap-3">
            <legend className="mb-1 text-sm font-medium">tickets.csv columns for</legend>
            {CSV_PRESET_OPTIONS.map((option) => (
              <div key={option.id} className="flex items-start gap-2">
                <input
                  type="radio"
                  id={`preset-${option.id}`}
                  name="preset"
                  value={option.id}
                  checked={chosenPreset === option.id}
                  onChange={() => setPreset(option.id)}
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
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => create.mutate()} disabled={create.isPending || run.data?.status !== 'complete'}>
              {create.isPending ? 'Exporting…' : 'Create export'}
            </Button>
            <Button variant="outline" onClick={() => setShowPreview((v) => !v)} aria-expanded={showPreview} aria-controls="report-preview">
              {showPreview ? 'Hide report preview' : 'Preview the report'}
            </Button>
          </div>
          {create.isError && (
            <Alert variant="destructive" role="alert">
              {create.error.message}
            </Alert>
          )}
          <p role="status" className="text-sm">
            {create.isSuccess && `Export ready: ${create.data.name}`}
          </p>
        </CardContent>
      </Card>

      {showPreview && (
        <Card id="report-preview">
          <CardHeader>
            <CardTitle>Report preview</CardTitle>
            <CardDescription>A simplified view of {choices.find((c) => c.id === shown)!.file}. Layout and styling differ in Word.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {choices.length > 1 && (
              <div className="grid max-w-sm gap-1">
                <Label htmlFor="preview-report">Report to preview</Label>
                <NativeSelect id="preview-report" value={shown} onChange={(e) => setPreviewing(e.target.value as PreviewReport)}>
                  {choices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}
            {preview.isPending && <p>Building the preview…</p>}
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
          </CardContent>
        </Card>
      )}

      {latest && <ExportCard summary={latest} heading="Latest export" />}
      {older.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Earlier exports</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {older.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span>
                    {formatDateTime(e.createdAt)} · {e.preset}
                  </span>
                  <a href={exportZipUrl(e.id)} className="text-primary underline" download>
                    Download {e.name}.zip
                  </a>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ExportCard({ summary, heading }: { summary: ExportSummary; heading: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{heading}</CardTitle>
        <CardDescription>
          {formatDateTime(summary.createdAt)} · CSV for {CSV_PRESET_OPTIONS.find((p) => p.id === summary.preset)?.label ?? summary.preset}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button asChild>
          <a href={exportZipUrl(summary.id)} download>
            <FileArchive aria-hidden="true" /> Download everything (.zip)
          </a>
        </Button>
        <ul className="grid gap-2 sm:grid-cols-2">
          {summary.files.map((file) => (
            <li key={file}>
              <a href={exportFileUrl(summary.id, file)} download className="inline-flex items-center gap-2 text-sm text-primary underline">
                <Download className="size-4" aria-hidden="true" /> {FILE_LABELS[file] ?? file}
              </a>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">
          Saved on this computer in <code className="break-all rounded bg-muted px-1">{summary.folder}</code>
        </p>
      </CardContent>
    </Card>
  );
}
