import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleStop, Loader2, RefreshCw } from 'lucide-react';
import { api, type VulnDbStatus } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** The local copy of public vulnerability data: how old it is, where it comes from, and updating it. */
export function VulnDbSettings() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['vulndb'], queryFn: api.vulnDb, refetchInterval: (q) => (q.state.data?.updating ? 1000 : false) });
  const set = (data: VulnDbStatus) => queryClient.setQueryData(['vulndb'], data);
  const update = useMutation({ mutationFn: api.updateVulnDb, onSuccess: set });
  const stop = useMutation({ mutationFn: api.stopVulnDbUpdate, onSuccess: set });
  const auto = useMutation({ mutationFn: api.setVulnDbAutoUpdate, onSuccess: set });
  // The tick follows the click straight away; the saved value takes over once there's no choice pending.
  const [autoChoice, setAutoChoice] = useState<boolean | null>(null);
  const data = status.data;
  const age = data?.ageDays;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Vulnerability data</CardTitle>
        <CardDescription>
          The Outdated JavaScript libraries and Known vulnerable software checks compare the versions a site shows visitors with a copy of public vulnerability databases
          kept on this computer. Updating downloads the databases for a fixed list of common software: nothing about the sites you audit is sent anywhere.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {status.isError && (
          <Alert variant="destructive" role="alert">
            {status.error.message}
          </Alert>
        )}
        {data && (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2" aria-live="polite">
              <p className="font-medium">
                {data.manifest?.updatedAt ? `Last updated ${formatDateTime(data.manifest.updatedAt)}` : 'Not downloaded yet: audits use the copy that came with Prego.'}
              </p>
              {age !== null && age !== undefined && (
                <Badge variant={age < 7 ? 'success' : age < 30 ? 'medium' : 'critical'}>{age === 0 ? 'Up to date' : age === 1 ? '1 day old' : `${age} days old`}</Badge>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {data.updating ? (
                <>
                  <p role="status" className="flex items-center gap-2 text-sm">
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    {data.progress ? `${data.progress.stage}${data.progress.total ? ` (${data.progress.done} of ${data.progress.total})` : ''}…` : 'Starting…'}
                  </p>
                  <Button type="button" variant="outline" size="sm" onClick={() => stop.mutate()} disabled={stop.isPending}>
                    <CircleStop aria-hidden="true" /> Stop
                  </Button>
                </>
              ) : (
                <Button type="button" onClick={() => update.mutate()} disabled={update.isPending}>
                  <RefreshCw aria-hidden="true" /> Update now
                </Button>
              )}
              {!data.updating && <span className="text-sm text-muted-foreground">Takes about a minute.</span>}
            </div>
            {data.error && !data.updating && (
              <Alert variant="destructive" role="alert">
                {data.error}
              </Alert>
            )}
            <div className="flex items-start gap-2">
              <Checkbox
                id="vulndb-auto"
                checked={autoChoice ?? data.autoUpdate}
                onCheckedChange={(state) => {
                  setAutoChoice(state === true);
                  auto.mutate(state === true, { onSettled: () => setAutoChoice(null) });
                }}
                aria-describedby="vulndb-auto-hint"
                className="mt-0.5"
              />
              <div className="grid gap-0.5">
                <Label htmlFor="vulndb-auto">Update automatically every week</Label>
                <span id="vulndb-auto-hint" className="text-sm text-muted-foreground">
                  While Prego is open, it updates the data in the background once it’s a week old. Reports say how current the data was for each audit.
                </span>
              </div>
            </div>
            {data.manifest && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Source</TableHead>
                    <TableHead>Licence</TableHead>
                    <TableHead className="text-right">Records</TableHead>
                    <TableHead>Downloaded</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.manifest.sources.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>
                        <a href={s.url} className="text-primary underline" target="_blank" rel="noreferrer">
                          {s.name}
                        </a>
                        {s.error && <p className="text-sm text-destructive">Last update failed: {s.error}</p>}
                      </TableCell>
                      <TableCell>{s.licence}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.records.toLocaleString('en-GB')}</TableCell>
                      <TableCell>{s.fetchedAt ? formatDateTime(s.fetchedAt) : 'Never'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
