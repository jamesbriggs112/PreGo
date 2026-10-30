import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Circle } from 'lucide-react';
import { api, type JourneySummary, type ProjectListItem } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';

interface Props {
  projectName: string;
  projects: ProjectListItem[] | undefined;
  /** Selected journey name. */
  value: string;
  onChange: (journey: JourneySummary | null) => void;
  /** Start address offered for a new recording. */
  defaultUrl: string;
  /** Used inside a <fieldset>; this is its legend. */
  legend: string;
  /** Allow "none" (for login journeys, which are optional). */
  optional?: boolean;
}

/**
 * Choose one of the project's recorded journeys, or record a new one. Recording opens Playwright's
 * code generator in a browser window on this computer; closing the window saves the journey.
 */
export function JourneyPicker({ projectName, projects, value, onChange, defaultUrl, legend, optional }: Props) {
  const queryClient = useQueryClient();
  const project = projects?.find((p) => p.name.toLowerCase() === projectName.trim().toLowerCase());
  const list = useQuery({
    queryKey: ['journeys', project?.id],
    queryFn: () => api.journeys(project!.id),
    enabled: !!project,
    // Poll while a recording is open, so the new journey appears when its window closes.
    refetchInterval: (q) => (q.state.data?.recordings.some((r) => r.status === 'recording') ? 1500 : false),
  });
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');

  const record = useMutation({
    mutationFn: async () => {
      // A new project is created first, since journeys belong to a project.
      const id = project?.id ?? (await api.createProject(projectName.trim())).id;
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      return api.recordJourney(id, name.trim(), (url || defaultUrl).trim());
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['journeys'] }),
  });

  const journeys = list.data?.journeys ?? [];
  const recording = list.data?.recordings.find((r) => r.status === 'recording');
  const failed = list.data?.recordings.filter((r) => r.status === 'failed') ?? [];
  const id = legend.replace(/\W+/g, '-').toLowerCase();

  return (
    <div className="grid gap-4">
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{legend}</legend>
        {!projectName.trim() && <p className="text-sm text-muted-foreground">Enter a project name first: journeys are saved per project.</p>}
        {projectName.trim() && journeys.length === 0 && !optional && <p className="text-sm text-muted-foreground">No journeys recorded for this project yet. Record one below.</p>}
        {optional && journeys.length > 0 && (
          <JourneyOption id={`${id}-none`} name={`${id}-choice`} checked={!value} onSelect={() => onChange(null)} label="Don’t log in" />
        )}
        {journeys.map((j) => (
          <JourneyOption
            key={j.name}
            id={`${id}-${j.name}`}
            name={`${id}-choice`}
            checked={value === j.name}
            onSelect={() => onChange(j)}
            label={j.name}
            hint={`${j.steps.length} steps from ${j.startUrl ?? 'an unknown address'}, recorded ${formatDateTime(j.recordedAt)}${j.unsupported.length ? `. ${j.unsupported.length} recorded actions can’t be replayed (popups or non-page code) and will be skipped.` : ''}`}
          />
        ))}
      </fieldset>

      <div className="grid gap-3 rounded-md border bg-muted/40 p-3">
        <p className="text-sm font-medium">Record a new journey</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-name`}>Journey name</Label>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. book-a-ticket" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-url`}>Start address</Label>
            <Input id={`${id}-url`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={defaultUrl || 'https://'} />
          </div>
        </div>
        <div>
          <Button type="button" variant="outline" onClick={() => record.mutate()} disabled={!projectName.trim() || !name.trim() || !(url || defaultUrl) || record.isPending || !!recording}>
            <Circle aria-hidden="true" className="fill-destructive text-destructive" /> Record journey
          </Button>
        </div>
        <p role="status" className="text-sm">
          {recording && `Recording “${recording.name}”: a browser window has opened. Click through the journey, then close that window to save it.`}
        </p>
        {(record.isError || failed.length > 0) && (
          <Alert variant="destructive" role="alert">
            {record.error?.message ?? failed.map((f) => `“${f.name}”: ${f.error}`).join(' ')}
          </Alert>
        )}
      </div>
    </div>
  );
}

function JourneyOption({ id, name, checked, onSelect, label, hint }: { id: string; name: string; checked: boolean; onSelect: () => void; label: string; hint?: string }) {
  return (
    <div className="flex items-start gap-2">
      <input type="radio" id={id} name={name} checked={checked} onChange={onSelect} aria-describedby={hint ? `${id}-hint` : undefined} className="mt-0.5 size-4 accent-primary" />
      <div className="grid gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        {hint && (
          <span id={`${id}-hint`} className="text-sm text-muted-foreground">
            {hint}
          </span>
        )}
      </div>
    </div>
  );
}
