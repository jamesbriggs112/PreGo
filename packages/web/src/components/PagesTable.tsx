import type { Location } from '@prego/core/types';
import type { ApiTicket, RunDetail } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** How the ticket list's page filter names a location. */
export function pageLabel(run: RunDetail, l: Location): string {
  if (l.kind !== 'state') return l.url;
  return run.mode === 'journey' ? (l.title ?? '') : `Screen: ${l.title}`;
}

/** The Pages tab: every page found, whether it was audited, and its open tickets. */
export function PagesTable({ run, tickets, onShowTickets }: { run: RunDetail; tickets: ApiTicket[]; onShowTickets: (page: string) => void }) {
  const noun = run.mode === 'crawl' ? 'Page' : run.mode === 'journey' ? 'Step' : 'Screen';
  const open = tickets.filter((t) => t.status !== 'Dismissed');
  const countFor = (l: Location) => open.filter((t) => t.locationIds.includes(l.id)).length;
  const rows = [...run.locations].sort((a, b) => Number(b.audited) - Number(a.audited) || a.depth - b.depth || a.url.localeCompare(b.url));
  const audited = rows.filter((l) => l.audited).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{noun}s</CardTitle>
        <CardDescription>
          {audited} of {rows.length} audited. Pages that share a template with one already audited are listed but not audited again, unless the audit was set to check every page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableCaption>
            {rows.length} {rows.length === 1 ? noun.toLowerCase() : `${noun.toLowerCase()}s`} found
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{noun}</TableHead>
              {run.mode === 'crawl' && <TableHead scope="col">Template</TableHead>}
              <TableHead scope="col">Audited</TableHead>
              <TableHead scope="col" className="text-right">
                Tickets
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((l) => {
              const count = countFor(l);
              return (
                <TableRow key={l.id}>
                  <TableCell className="max-w-md">
                    <span className="block truncate font-medium">{l.title || (l.kind === 'state' ? 'Untitled screen' : 'Untitled page')}</span>
                    {l.kind !== 'state' && <span className="block truncate text-xs break-all text-muted-foreground">{l.url}</span>}
                    {l.statusCode && l.statusCode >= 400 && <span className="block text-xs text-destructive">Returned {l.statusCode}</span>}
                  </TableCell>
                  {run.mode === 'crawl' && <TableCell className="text-sm text-muted-foreground">{l.templateKey ?? '–'}</TableCell>}
                  <TableCell className="text-sm">{l.audited ? 'Yes' : <span className="text-muted-foreground">{l.notAuditedReason ?? 'No'}</span>}</TableCell>
                  <TableCell className="text-right">
                    {l.audited && count > 0 ? (
                      <Button
                        variant="link"
                        className="h-auto p-0"
                        onClick={() => onShowTickets(pageLabel(run, l))}
                        aria-label={`Show the ${count} tickets on ${l.title || l.url}`}
                      >
                        {count}
                      </Button>
                    ) : l.audited ? (
                      '0'
                    ) : (
                      '–'
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
