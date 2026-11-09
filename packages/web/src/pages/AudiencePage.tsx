import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Sparkles, Trash2 } from 'lucide-react';
import type { AudienceProfile, Persona, PersonaDevice, Purpose, TaskSuccess, UserTask } from '@prego/core/types';
import { api } from '@/lib/api';
import { useTitle } from '@/lib/use-title';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const EMPTY: AudienceProfile = { purposes: [], personas: [], tasks: [], updatedAt: '' };

const DEVICES: { id: PersonaDevice; label: string }[] = [
  { id: 'mobile', label: 'Phone' },
  { id: 'desktop', label: 'Desktop or laptop' },
  { id: 'tablet', label: 'Tablet' },
  { id: 'any', label: 'Any device' },
];

const SUCCESS: { id: string; label: string }[] = [
  { id: 'page', label: 'Reaching a page' },
  { id: 'contact', label: 'Finding contact details' },
  { id: 'form:contact', label: 'Finding a contact form' },
  { id: 'form:login', label: 'Finding the log-in form' },
  { id: 'form:search', label: 'Finding the search' },
  { id: 'form:newsletter', label: 'Finding the newsletter sign-up' },
  { id: 'described', label: 'Described only' },
];

const successId = (s: TaskSuccess) => (s.kind === 'form' ? `form:${s.form}` : s.kind);
function successFrom(id: string, path: string): TaskSuccess {
  if (id === 'page') return { kind: 'page', path };
  if (id === 'contact') return { kind: 'contact' };
  if (id.startsWith('form:')) return { kind: 'form', form: id.slice(5) as 'contact' };
  return { kind: 'described' };
}

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Suggestions added to what's there: purposes and personas with names not already used, with their tasks. */
function mergeSuggestion(current: AudienceProfile, suggested: AudienceProfile): AudienceProfile {
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const purposeIds = new Map<string, string>();
  const purposes = [...current.purposes];
  for (const p of suggested.purposes) {
    const existing = current.purposes.find((c) => same(c.title, p.title));
    if (existing) purposeIds.set(p.id, existing.id);
    else {
      const id = current.purposes.some((c) => c.id === p.id) ? newId('purpose') : p.id;
      purposeIds.set(p.id, id);
      purposes.push({ ...p, id });
    }
  }
  const personas = [...current.personas];
  const tasks = [...current.tasks];
  for (const p of suggested.personas) {
    if (current.personas.some((c) => same(c.name, p.name))) continue;
    const id = current.personas.some((c) => c.id === p.id) ? newId('persona') : p.id;
    personas.push({ ...p, id, purposeIds: p.purposeIds.map((x) => purposeIds.get(x) ?? x) });
    for (const t of suggested.tasks.filter((t) => t.personaId === p.id)) tasks.push({ ...t, id: tasks.some((c) => c.id === t.id) ? newId('task') : t.id, personaId: id });
  }
  return { ...current, purposes, personas, tasks };
}

/** A project's purposes, personas and tasks: suggested from its latest audit, then edited here. */
export function AudiencePage() {
  const projectId = Number(useParams().projectId);
  const queryClient = useQueryClient();
  const project = useQuery({ queryKey: ['project', projectId], queryFn: () => api.project(projectId) });
  const audience = useQuery({ queryKey: ['audience', projectId], queryFn: () => api.audience(projectId) });
  const [draft, setDraft] = useState<AudienceProfile | null>(null);
  const [dirty, setDirty] = useState(false);
  useTitle(project.data ? `Purposes and audience: ${project.data.name}` : 'Purposes and audience');

  const suggest = useMutation({
    mutationFn: () => api.suggestAudience(projectId),
    onSuccess: (suggestion) => {
      setDraft((d) => mergeSuggestion(d ?? audience.data?.profile ?? EMPTY, suggestion.profile));
      setDirty(true);
    },
  });
  const save = useMutation({
    mutationFn: (profile: AudienceProfile) => api.saveAudience(projectId, profile),
    onSuccess: ({ profile }) => {
      setDraft(profile);
      setDirty(false);
      queryClient.setQueryData(['audience', projectId], (old: object | undefined) => ({ ...old, profile }));
      return queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });

  // Edits go into a draft until saved; until the first edit, show what's saved.
  const profile = draft ?? audience.data?.profile ?? EMPTY;
  const change = (next: Partial<AudienceProfile>) => {
    setDraft({ ...profile, ...next });
    setDirty(true);
  };
  const setPurpose = (id: string, patch: Partial<Purpose>) => change({ purposes: profile.purposes.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  const setPersona = (id: string, patch: Partial<Persona>) => change({ personas: profile.personas.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  const setTask = (id: string, patch: Partial<UserTask>) => change({ tasks: profile.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  const gaps = profile.purposes.filter((p) => p.intended && !p.current);
  const pages = audience.data?.pages ?? [];

  return (
    <div className="space-y-6">
      <Link to="/projects" className="inline-flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> All projects
      </Link>
      <div>
        <h1 className="text-2xl font-bold">Purposes and audience{project.data ? `: ${project.data.name}` : ''}</h1>
        <p className="text-muted-foreground">
          What the site is for, who uses it and what they come to do. Prego can suggest a starting point from the latest audit; change anything, and add what the client’s
          brief says the site should achieve. Saved for the project and used in its reports.
        </p>
      </div>

      {(audience.isError || project.isError) && (
        <Alert variant="destructive" role="alert">
          {(audience.error ?? project.error)?.message}
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" onClick={() => suggest.mutate()} disabled={suggest.isPending || !audience.data?.latestRunId}>
          <Sparkles aria-hidden="true" /> {suggest.isPending ? 'Suggesting…' : profile.purposes.length ? 'Add suggestions from the latest audit' : 'Suggest from the latest audit'}
        </Button>
        {audience.data && !audience.data.latestRunId && <span className="text-sm text-muted-foreground">Run an audit of this site first, then Prego can suggest.</span>}
        <p role="status" className="text-sm text-muted-foreground">
          {suggest.isSuccess && (suggest.data.source === 'ai' ? 'Added suggestions from the AI model on this computer. Check them before saving.' : 'Added Prego’s suggestions. Check them before saving.')}
        </p>
      </div>
      {suggest.data?.note && <Alert role="note">{suggest.data.note}</Alert>}
      {suggest.isError && (
        <Alert variant="destructive" role="alert">
          {suggest.error.message}
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Purposes</CardTitle>
          <CardDescription>
            What the site exists to do. Tick whether it does each one now, and whether the client wants it. Something the client wants that the site doesn’t do yet is a gap.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {profile.purposes.length === 0 && <p className="text-sm text-muted-foreground">No purposes yet.</p>}
          {profile.purposes.map((p, i) => (
            <Item key={p.id} legend={p.title || `Purpose ${i + 1}`} onRemove={() => change({ purposes: profile.purposes.filter((x) => x.id !== p.id), personas: profile.personas.map((x) => ({ ...x, purposeIds: x.purposeIds.filter((id) => id !== p.id) })) })}>
              <Field id={`${p.id}-title`} label="Purpose">
                <Input id={`${p.id}-title`} value={p.title} onChange={(e) => setPurpose(p.id, { title: e.target.value })} maxLength={120} />
              </Field>
              <Field id={`${p.id}-description`} label="Description">
                <Textarea id={`${p.id}-description`} rows={2} value={p.description} onChange={(e) => setPurpose(p.id, { description: e.target.value })} />
              </Field>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                <Tick id={`${p.id}-current`} checked={p.current} onChange={(on) => setPurpose(p.id, { current: on })} label="The site does this now" />
                <Tick id={`${p.id}-intended`} checked={p.intended} onChange={(on) => setPurpose(p.id, { intended: on })} label="The client wants this" />
              </div>
              <Field id={`${p.id}-priority`} label="Importance">
                <NativeSelect id={`${p.id}-priority`} value={p.priority} onChange={(e) => setPurpose(p.id, { priority: e.target.value as Purpose['priority'] })} className="max-w-xs">
                  <option value="primary">Main purpose</option>
                  <option value="secondary">Secondary</option>
                </NativeSelect>
              </Field>
              {p.evidence.length > 0 && <p className="text-sm text-muted-foreground">Evidence: {p.evidence.join('; ')}</p>}
            </Item>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => change({ purposes: [...profile.purposes, { id: newId('purpose'), title: '', description: '', current: false, intended: true, priority: 'primary', evidence: [] }] })}
          >
            <Plus aria-hidden="true" /> Add a purpose
          </Button>
          {gaps.length > 0 && (
            <p className="text-sm">
              <span className="font-medium">Gaps:</span> the client wants the site to {gaps.map((g) => g.title.charAt(0).toLowerCase() + g.title.slice(1)).join('; ')}, but it doesn’t yet.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Personas and tasks</CardTitle>
          <CardDescription>
            The people the site serves, including internal users, and what each comes to do. A task says how you’d know it was done, so Prego can check it against the site
            later.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {profile.personas.length === 0 && <p className="text-sm text-muted-foreground">No personas yet.</p>}
          {profile.personas.map((p, i) => (
            <Item key={p.id} legend={p.name || `Persona ${i + 1}`} onRemove={() => change({ personas: profile.personas.filter((x) => x.id !== p.id), tasks: profile.tasks.filter((t) => t.personaId !== p.id) })}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id={`${p.id}-name`} label="Name">
                  <Input id={`${p.id}-name`} value={p.name} onChange={(e) => setPersona(p.id, { name: e.target.value })} maxLength={120} />
                </Field>
                <Field id={`${p.id}-device`} label="Device">
                  <NativeSelect id={`${p.id}-device`} value={p.device} onChange={(e) => setPersona(p.id, { device: e.target.value as PersonaDevice })}>
                    {DEVICES.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.label}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              </div>
              <Field id={`${p.id}-summary`} label="Who they are and what they want">
                <Textarea id={`${p.id}-summary`} rows={2} value={p.summary} onChange={(e) => setPersona(p.id, { summary: e.target.value })} />
              </Field>
              <Field id={`${p.id}-context`} label="Their situation">
                <Textarea id={`${p.id}-context`} rows={2} value={p.context} onChange={(e) => setPersona(p.id, { context: e.target.value })} />
              </Field>
              <Field id={`${p.id}-access`} label="Access needs">
                <Input id={`${p.id}-access`} value={p.accessNeeds} onChange={(e) => setPersona(p.id, { accessNeeds: e.target.value })} placeholder="For example, screen reader and keyboard only" />
              </Field>
              <Tick id={`${p.id}-internal`} checked={p.internal} onChange={(on) => setPersona(p.id, { internal: on })} label="Internal user (works for the organisation)" />
              {profile.purposes.length > 0 && (
                <fieldset className="grid gap-2">
                  <legend className="mb-1 text-sm font-medium">Cares about</legend>
                  {profile.purposes.map((purpose) => (
                    <Tick
                      key={purpose.id}
                      id={`${p.id}-cares-${purpose.id}`}
                      checked={p.purposeIds.includes(purpose.id)}
                      onChange={(on) => setPersona(p.id, { purposeIds: on ? [...p.purposeIds, purpose.id] : p.purposeIds.filter((x) => x !== purpose.id) })}
                      label={purpose.title || 'Untitled purpose'}
                    />
                  ))}
                </fieldset>
              )}

              <div className="space-y-3 border-t pt-3">
                <h3 className="text-sm font-medium">Tasks for {p.name || 'this persona'}</h3>
                {profile.tasks
                  .filter((t) => t.personaId === p.id)
                  .map((t, n) => (
                    <Item key={t.id} legend={t.goal || `Task ${n + 1}`} onRemove={() => change({ tasks: profile.tasks.filter((x) => x.id !== t.id) })} compact>
                      <Field id={`${t.id}-goal`} label="What they’re trying to do">
                        <Input id={`${t.id}-goal`} value={t.goal} onChange={(e) => setTask(t.id, { goal: e.target.value })} maxLength={200} />
                      </Field>
                      <Field id={`${t.id}-done`} label="They’d know it was done when">
                        <Input id={`${t.id}-done`} value={t.doneWhen} onChange={(e) => setTask(t.id, { doneWhen: e.target.value })} maxLength={300} />
                      </Field>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field id={`${t.id}-success`} label="Prego checks it by">
                          <NativeSelect
                            id={`${t.id}-success`}
                            value={successId(t.success)}
                            onChange={(e) => setTask(t.id, { success: successFrom(e.target.value, t.success.kind === 'page' ? t.success.path : (pages[0] ?? '/')) })}
                          >
                            {SUCCESS.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.label}
                              </option>
                            ))}
                          </NativeSelect>
                        </Field>
                        {t.success.kind === 'page' && (
                          <Field id={`${t.id}-page`} label="Page address">
                            <Input id={`${t.id}-page`} list="audience-pages" value={t.success.path} onChange={(e) => setTask(t.id, { success: { kind: 'page', path: e.target.value } })} placeholder="/contact" />
                          </Field>
                        )}
                      </div>
                    </Item>
                  ))}
                <Button type="button" variant="outline" size="sm" onClick={() => change({ tasks: [...profile.tasks, { id: newId('task'), personaId: p.id, goal: '', doneWhen: '', success: { kind: 'described' } }] })}>
                  <Plus aria-hidden="true" /> Add a task<span className="sr-only"> for {p.name || 'this persona'}</span>
                </Button>
              </div>
            </Item>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => change({ personas: [...profile.personas, { id: newId('persona'), name: '', summary: '', context: '', device: 'any', accessNeeds: '', internal: false, purposeIds: [] }] })}
          >
            <Plus aria-hidden="true" /> Add a persona
          </Button>
        </CardContent>
      </Card>
      <datalist id="audience-pages">
        {pages.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>

      <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t bg-background py-3">
        <Button type="button" onClick={() => save.mutate(profile)} disabled={save.isPending || !dirty}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <p role="status" className="text-sm text-muted-foreground">
          {dirty ? 'Unsaved changes.' : save.isSuccess ? 'Saved.' : ''}
        </p>
        {save.isError && (
          <Alert variant="destructive" role="alert">
            {save.error.message}
          </Alert>
        )}
      </div>
    </div>
  );
}

function Item({ legend, onRemove, compact, children }: { legend: string; onRemove: () => void; compact?: boolean; children: ReactNode }) {
  return (
    <fieldset className={compact ? 'grid gap-3 rounded-lg bg-muted/50 p-3' : 'grid gap-4 rounded-xl border p-4'}>
      <legend className="sr-only">{legend}</legend>
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium" aria-hidden="true">
          {legend}
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          <Trash2 aria-hidden="true" /> Remove<span className="sr-only"> {legend}</span>
        </Button>
      </div>
      {children}
    </fieldset>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function Tick({ id, checked, onChange, label }: { id: string; checked: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(state) => onChange(state === true)} />
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
    </div>
  );
}
