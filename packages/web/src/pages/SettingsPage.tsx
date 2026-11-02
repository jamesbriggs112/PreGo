import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PROFILES } from '@prego/core/profiles';
import { api, type Settings } from '@/lib/api';
import { CSV_PRESET_OPTIONS } from '@/lib/presets';
import { useTitle } from '@/lib/use-title';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function SettingsPage() {
  useTitle('Settings');
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">Branding for reports, and defaults for new audits. Saved on this computer.</p>
      </div>
      {settings.isPending && <p>Loading settings…</p>}
      {settings.isError && (
        <Alert variant="destructive" role="alert">
          {settings.error.message}
        </Alert>
      )}
      {settings.data && <SettingsForm initial={settings.data} />}
      <LogoCard hasLogo={!!settings.data?.hasLogo} />
    </div>
  );
}

function SettingsForm({ initial }: { initial: Settings }) {
  const queryClient = useQueryClient();
  const [companyName, setCompanyName] = useState(initial.branding.companyName);
  const [accent, setAccent] = useState(`#${initial.branding.accentColour}`);
  const [viewports, setViewports] = useState<string[]>(initial.defaults.viewports);
  const [perTemplate, setPerTemplate] = useState(String(initial.defaults.perTemplate));
  const [concurrency, setConcurrency] = useState(String(initial.defaults.concurrency));
  const [delay, setDelay] = useState(String(initial.defaults.delayMs));
  const [respectRobots, setRespectRobots] = useState(initial.defaults.respectRobots);
  const [csvPreset, setCsvPreset] = useState(initial.defaults.csvPreset);
  const [checks, setChecks] = useState<string[]>(initial.defaults.checks);
  const checkList = useQuery({ queryKey: ['checks'], queryFn: api.checks });
  const [aiEnabled, setAiEnabled] = useState(initial.ai.enabled);
  const [aiUrl, setAiUrl] = useState(initial.ai.url);
  const [aiModel, setAiModel] = useState(initial.ai.model);
  const testOllama = useMutation({ mutationFn: api.testOllama });

  const save = useMutation({
    mutationFn: api.saveSettings,
    onSuccess: (saved) => {
      queryClient.setQueryData(['settings'], saved);
      // Whether AI review can be chosen on the New audit form.
      return queryClient.invalidateQueries({ queryKey: ['checks'] });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    save.mutate({
      branding: { companyName: companyName.trim(), accentColour: accent.replace('#', '') },
      defaults: { viewports, perTemplate: Number(perTemplate), concurrency: Number(concurrency), delayMs: Number(delay), respectRobots, csvPreset, checks },
      ai: { enabled: aiEnabled, url: aiUrl.trim(), model: aiModel.trim() },
    });
  }

  const order = Object.keys(PROFILES);
  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Report branding</CardTitle>
          <CardDescription>Shown on the Word report’s cover and footer. Four’s branded template can replace this when it’s supplied.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="company-name">Company name</Label>
            <Input id="company-name" value={companyName} onChange={(e) => setCompanyName(e.target.value)} required maxLength={100} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="accent-colour">Accent colour</Label>
            <div className="flex items-center gap-2">
              <input
                id="accent-colour"
                type="color"
                value={accent}
                onChange={(e) => setAccent(e.target.value)}
                className="h-9 w-14 cursor-pointer rounded-md border border-input bg-background p-1"
              />
              <span className="font-mono text-sm" aria-hidden="true">
                {accent.toUpperCase()}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>New audit defaults</CardTitle>
          <CardDescription>Starting values for the New audit form. You can still change them per audit.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          <fieldset className="grid gap-2 sm:row-span-2">
            <legend className="mb-1 text-sm font-medium">Screen sizes</legend>
            {Object.values(PROFILES).map((profile) => (
              <div key={profile.name} className="flex items-center gap-2">
                <Checkbox
                  id={`default-viewport-${profile.name}`}
                  checked={viewports.includes(profile.name)}
                  onCheckedChange={(state) =>
                    setViewports((current) =>
                      (state === true ? [...current, profile.name] : current.filter((v) => v !== profile.name)).sort((a, b) => order.indexOf(a) - order.indexOf(b)),
                    )
                  }
                />
                <Label htmlFor={`default-viewport-${profile.name}`} className="font-normal">
                  {profile.label}
                </Label>
              </div>
            ))}
            {viewports.length === 0 && (
              <p className="text-sm text-destructive" role="alert">
                Choose at least one screen size.
              </p>
            )}
          </fieldset>
          <div className="grid gap-2">
            <Label htmlFor="default-per-template">Pages audited per template</Label>
            <Input id="default-per-template" type="number" min={1} value={perTemplate} onChange={(e) => setPerTemplate(e.target.value)} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="default-concurrency">Pages open at once</Label>
            <Input id="default-concurrency" type="number" min={1} max={8} value={concurrency} onChange={(e) => setConcurrency(e.target.value)} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="default-delay">Delay between pages (milliseconds)</Label>
            <Input id="default-delay" type="number" min={0} value={delay} onChange={(e) => setDelay(e.target.value)} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="default-preset">tickets.csv columns</Label>
            <NativeSelect id="default-preset" value={csvPreset} onChange={(e) => setCsvPreset(e.target.value)}>
              {CSV_PRESET_OPTIONS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <fieldset className="grid gap-2 sm:col-span-2">
            <legend className="mb-1 text-sm font-medium">Checks ticked by default</legend>
            {checkList.data?.map((check) => (
              <div key={check.id} className="flex items-center gap-2">
                <Checkbox
                  id={`default-check-${check.id}`}
                  checked={checks.includes(check.id)}
                  onCheckedChange={(state) => setChecks((current) => (state === true ? [...current, check.id] : current.filter((c) => c !== check.id)))}
                />
                <Label htmlFor={`default-check-${check.id}`} className="font-normal">
                  {check.name}
                </Label>
              </div>
            ))}
          </fieldset>
          <div className="flex items-center gap-2 sm:col-span-2">
            <Checkbox id="default-robots" checked={respectRobots} onCheckedChange={(state) => setRespectRobots(state === true)} />
            <Label htmlFor="default-robots" className="font-normal">
              Respect robots.txt
            </Label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI review (optional)</CardTitle>
          <CardDescription>
            A vision model running in Ollama on this computer reviews a screenshot of each template against Nielsen’s 10 usability heuristics. Screenshots never leave this
            computer. Its findings are marked AI-suggested and stay out of scores and reports until you approve them.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          <div className="flex items-center gap-2 sm:col-span-2">
            <Checkbox id="ai-enabled" checked={aiEnabled} onCheckedChange={(state) => setAiEnabled(state === true)} />
            <Label htmlFor="ai-enabled" className="font-normal">
              Offer AI review on the New audit form
            </Label>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ai-url">Ollama address</Label>
            <Input id="ai-url" value={aiUrl} onChange={(e) => setAiUrl(e.target.value)} required aria-describedby="ai-url-hint" />
            <span id="ai-url-hint" className="text-sm text-muted-foreground">
              Must be on this computer, such as http://127.0.0.1:11434.
            </span>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ai-model">Vision model</Label>
            <Input id="ai-model" value={aiModel} onChange={(e) => setAiModel(e.target.value)} required aria-describedby="ai-model-hint" list="ai-models" />
            <datalist id="ai-models">
              {testOllama.data?.models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <span id="ai-model-hint" className="text-sm text-muted-foreground">
              A model that reads images, pulled with ollama pull, such as qwen2.5vl:7b.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="button" variant="outline" onClick={() => testOllama.mutate(aiUrl.trim())} disabled={testOllama.isPending}>
              {testOllama.isPending ? 'Checking…' : 'Check Ollama'}
            </Button>
            <p role="status" className="text-sm">
              {testOllama.isSuccess &&
                (testOllama.data.models.length
                  ? `Ollama is running with ${testOllama.data.models.length === 1 ? '1 model' : `${testOllama.data.models.length} models`}: ${testOllama.data.models.join(', ')}.${testOllama.data.models.includes(aiModel.trim()) ? '' : ` “${aiModel.trim()}” isn’t one of them yet: run ollama pull ${aiModel.trim()}.`}`
                  : 'Ollama is running but has no models. Pull a vision model first.')}
            </p>
          </div>
          {testOllama.isError && (
            <Alert variant="destructive" role="alert" className="sm:col-span-2">
              {testOllama.error.message}
            </Alert>
          )}
        </CardContent>
      </Card>

      {save.isError && (
        <Alert variant="destructive" role="alert">
          {save.error.message}
        </Alert>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending || viewports.length === 0}>
          {save.isPending ? 'Saving…' : 'Save settings'}
        </Button>
        <p role="status" className="text-sm">
          {save.isSuccess && 'Settings saved.'}
        </p>
      </div>
    </form>
  );
}

function LogoCard({ hasLogo }: { hasLogo: boolean }) {
  const queryClient = useQueryClient();
  const [version, setVersion] = useState(0);
  const refresh = () => {
    setVersion((v) => v + 1);
    return queryClient.invalidateQueries({ queryKey: ['settings'] });
  };
  const upload = useMutation({ mutationFn: api.uploadLogo, onSuccess: refresh });
  const remove = useMutation({ mutationFn: api.removeLogo, onSuccess: refresh });

  function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => upload.mutate(String(reader.result));
    reader.readAsDataURL(file);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Report logo</CardTitle>
        <CardDescription>A PNG shown on the report cover. Kept in Prego’s data folder, not in git.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasLogo && <img src={`/api/settings/logo?v=${version}`} alt="Current report logo" className="max-h-20 rounded border bg-white p-2" />}
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-2">
            <Label htmlFor="logo-file">{hasLogo ? 'Replace logo' : 'Upload logo'}</Label>
            <Input id="logo-file" type="file" accept="image/png" onChange={onFile} className="max-w-xs" />
          </div>
          {hasLogo && (
            <Button variant="outline" onClick={() => remove.mutate()} disabled={remove.isPending}>
              Remove logo
            </Button>
          )}
        </div>
        {(upload.isError || remove.isError) && (
          <Alert variant="destructive" role="alert">
            {(upload.error ?? remove.error)?.message}
          </Alert>
        )}
        <p role="status" className="text-sm">
          {upload.isSuccess && 'Logo uploaded.'}
        </p>
      </CardContent>
    </Card>
  );
}
