import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Lock } from 'lucide-react';
import type { ClientInfo } from '@prego/core/types';
import { api } from '@/lib/api';
import { useTitle } from '@/lib/use-title';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type TextKey = 'about' | 'sector' | 'goals' | 'audiences' | 'constraints' | 'contacts' | 'notes';

const BACKGROUND: { key: TextKey; label: string; hint: string; rows: number }[] = [
  { key: 'about', label: 'About the organisation', hint: 'What they do and who for, in a sentence or two.', rows: 3 },
  { key: 'sector', label: 'Sector', hint: 'For example charity, higher education, retail, local government.', rows: 1 },
  { key: 'goals', label: 'What the site needs to achieve', hint: 'The client’s goals, in their words where you can. One per line.', rows: 4 },
  { key: 'audiences', label: 'Who the site is for', hint: 'The main groups of visitors, as the client describes them. One per line.', rows: 3 },
  { key: 'constraints', label: 'Constraints', hint: 'Anything that limits what can change: the platform, budget, deadlines, brand or legal rules.', rows: 3 },
];

const INTERNAL: { key: TextKey; label: string; hint: string; rows: number }[] = [
  { key: 'contacts', label: 'Contacts', hint: 'Who to talk to and their roles. Use work contact details only.', rows: 3 },
  { key: 'notes', label: 'Notes for the team', hint: 'Anything else worth knowing: history, sensitivities, what was promised.', rows: 4 },
];

/** What the team knows about the client, typed in by a person. */
export function ClientPage() {
  const projectId = Number(useParams().projectId);
  const queryClient = useQueryClient();
  const project = useQuery({ queryKey: ['project', projectId], queryFn: () => api.project(projectId) });
  const saved = useQuery({ queryKey: ['client', projectId], queryFn: () => api.client(projectId) });
  const [draft, setDraft] = useState<ClientInfo | null>(null);
  const [status, setStatus] = useState('');
  useTitle(project.data ? `Client details: ${project.data.name}` : 'Client details');

  const info: ClientInfo = draft ?? saved.data?.client ?? {};
  const set = (patch: Partial<ClientInfo>) => {
    setDraft({ ...info, ...patch });
    setStatus('');
  };
  const save = useMutation({
    mutationFn: () => api.saveClient(projectId, info),
    onSuccess: (result) => {
      queryClient.setQueryData(['client', projectId], result);
      setDraft(null);
      setStatus('Saved.');
      return queryClient.invalidateQueries({ queryKey: ['run'] });
    },
  });

  const field = (f: { key: TextKey; label: string; hint: string; rows: number }) => (
    <div key={f.key} className="grid gap-1.5">
      <Label htmlFor={`client-${f.key}`}>{f.label}</Label>
      <span id={`client-${f.key}-hint`} className="text-sm text-muted-foreground">
        {f.hint}
      </span>
      {f.rows === 1 ? (
        <Input id={`client-${f.key}`} aria-describedby={`client-${f.key}-hint`} value={info[f.key] ?? ''} onChange={(e) => set({ [f.key]: e.target.value })} maxLength={200} />
      ) : (
        <Textarea
          id={`client-${f.key}`}
          aria-describedby={`client-${f.key}-hint`}
          rows={f.rows}
          value={info[f.key] ?? ''}
          onChange={(e) => set({ [f.key]: e.target.value })}
          maxLength={10_000}
        />
      )}
    </div>
  );

  return (
    <form
      className="max-w-3xl space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Link to="/projects" className="inline-flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> All projects
      </Link>
      <div>
        <h1 className="text-2xl font-bold">Client details{project.data ? `: ${project.data.name}` : ''}</h1>
        <p className="text-muted-foreground">
          What the team knows about the client, from briefs and conversations. Prego never fills this in or changes it: it’s yours. It stays on this computer with the project.
        </p>
        {saved.data?.client?.updatedAt && <p className="text-sm text-muted-foreground">Last saved {formatDateTime(saved.data.client.updatedAt)}.</p>}
      </div>

      {(saved.isError || project.isError) && (
        <Alert variant="destructive" role="alert">
          {(saved.error ?? project.error)?.message}
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Background</CardTitle>
          <CardDescription>Reports can include these when you tick “About the client” on the Export page.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">{BACKGROUND.map(field)}</CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Hosting</CardTitle>
          <CardDescription>Used for the carbon estimate in the site profile.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-1.5">
          <Label htmlFor="client-green">Does the host run on renewable energy?</Label>
          <span id="client-green-hint" className="text-sm text-muted-foreground">
            Ask the client or their host. Prego doesn’t look this up online, so nothing about the site is sent anywhere.
          </span>
          <NativeSelect
            id="client-green"
            aria-describedby="client-green-hint"
            className="max-w-xs"
            value={info.greenHosting ?? 'unknown'}
            onChange={(e) => set({ greenHosting: e.target.value === 'unknown' ? undefined : (e.target.value as 'yes' | 'no') })}
          >
            <option value="unknown">Don’t know</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </NativeSelect>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="size-4" aria-hidden="true" /> For the team only
          </CardTitle>
          <CardDescription>Never included in reports or exports.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">{INTERNAL.map(field)}</CardContent>
      </Card>

      {save.isError && (
        <Alert variant="destructive" role="alert">
          {save.error.message}
        </Alert>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending || !draft}>
          {save.isPending ? 'Saving…' : 'Save client details'}
        </Button>
        <p role="status" className="text-sm text-muted-foreground">
          {status || (draft ? 'Unsaved changes.' : '')}
        </p>
      </div>
    </form>
  );
}
