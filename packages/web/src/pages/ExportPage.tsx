import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Download, FileArchive } from 'lucide-react';
import { api, exportFileUrl, exportZipUrl, type ExportSummary } from '@/lib/api';
import { CSV_PRESET_OPTIONS } from '@/lib/presets';
import { useTitle } from '@/lib/use-title';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ReportContents } from '@/components/ReportContents';

const FILE_LABELS: Record<string, string> = {
  'overview.docx': 'Leadership summary (Word)',
  'client-report.docx': 'Client report (Word)',
  'report.docx': 'Developer report (Word)',
  'audience.docx': 'Audience and tasks (Word)',
  'future.docx': 'Search and future readiness (Word)',
  'tickets.csv': 'Tickets (CSV)',
  'occurrences.csv': 'Occurrences (CSV)',
  'run.json': 'Raw data (JSON)',
  'state-map.png': 'State map (PNG)',
};

export function ExportPage() {
  const runId = Number(useParams().runId);
  const run = useQuery({ queryKey: ['run', runId], queryFn: () => api.run(runId) });
  const exports = useQuery({ queryKey: ['exports', runId], queryFn: () => api.exports(runId) });
  useTitle(run.data ? `Export ${run.data.project.name}` : 'Export');
  const [latest, ...older] = exports.data ?? [];

  return (
    <div className="space-y-6">
      <Link to={`/runs/${runId}`} className="inline-flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> Back to results
      </Link>
      <div>
        <h1 className="text-2xl font-bold">Export{run.data ? ` ${run.data.project.name}` : ''}</h1>
        <p className="text-muted-foreground">One folder with the reports you choose, all cross-referenced by ticket ID. Dismissed tickets are left out.</p>
      </div>

      {run.data && (
        <Alert role="note">
          {run.data.screenshotsDeleted
            ? 'This audit’s screenshots were deleted when it was first exported, so a new export’s reports won’t have any. The earlier reports still have them.'
            : 'Exporting puts the screenshots into the Word reports and then deletes them from Prego. To keep them, keep the reports.'}
        </Alert>
      )}

      {run.data && <ReportContents run={run.data} />}

      {latest && <ExportCard summary={latest} heading="Latest export" />}
      {older.length > 0 && (
        <details className="rounded-xl border bg-card p-4">
          <summary className="cursor-pointer font-medium">Earlier exports ({older.length})</summary>
          <ul className="mt-2 divide-y">
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
        </details>
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
