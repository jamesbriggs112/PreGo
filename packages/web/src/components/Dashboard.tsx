import type { DashboardTile, LegalSummary, Rating } from '@prego/core/types';
import { AlertTriangle, CircleCheck, Info, Scale } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

// The results page's summary tiles with a traffic light each, and the possible legal risks panel.
// Colour is never the only signal: every light has a word next to it.

const LIGHTS: Record<Rating, { label: string; variant: 'success' | 'medium' | 'critical'; bar: string }> = {
  good: { label: 'Good', variant: 'success', bar: 'bg-[var(--badge-success-fg)]' },
  fair: { label: 'Fair', variant: 'medium', bar: 'bg-[var(--badge-medium-fg)]' },
  poor: { label: 'Poor', variant: 'critical', bar: 'bg-[var(--badge-critical-fg)]' },
};

export function Tile({ tile }: { tile: DashboardTile }) {
  const light = tile.rating ? LIGHTS[tile.rating] : null;
  return (
    <Card className="relative overflow-hidden">
      {light && <span aria-hidden="true" className={cn('absolute inset-y-0 left-0 w-1', light.bar)} />}
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardDescription>{tile.label}</CardDescription>
          {light && (
            <Badge variant={light.variant} className="shrink-0 gap-1">
              <span aria-hidden="true" className={cn('size-1.5 rounded-full', light.bar)} />
              {light.label}
            </Badge>
          )}
        </div>
        <CardTitle as="h3" className="text-3xl">
          {tile.value}
          {tile.suffix && <span className="text-base font-normal text-muted-foreground"> {tile.suffix}</span>}
        </CardTitle>
        {tile.note && <p className="text-xs text-muted-foreground">{tile.note}</p>}
      </CardHeader>
    </Card>
  );
}

export function LegalPanel({ legal }: { legal: LegalSummary }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Scale className="size-5" aria-hidden="true" /> Possible legal risks
        </CardTitle>
        <CardDescription>
          Signs from this audit that the site may not be meeting a legal obligation under UK law, and why. Prego can’t say whether the law is broken, and finding nothing here
          doesn’t mean the site complies. Check anything flagged with someone qualified.
          {legal.publicSector && ' The address looks like a UK public sector body, which has extra accessibility duties.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {legal.signals.length === 0 && (
          <p className="flex items-center gap-2 text-sm">
            <CircleCheck className="size-4 text-success" aria-hidden="true" /> No signs of a legal risk in what this audit checked.
          </p>
        )}
        {legal.signals.length > 0 && (
          <ul className="grid gap-3 lg:grid-cols-2">
            {legal.signals.map((signal) => (
              <li key={signal.id} className="grid content-start gap-2 rounded-xl border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold">{signal.area}</h3>
                  <Badge variant={signal.level === 'risk' ? 'critical' : 'medium'} className="gap-1">
                    <AlertTriangle className="size-3" aria-hidden="true" />
                    {signal.level === 'risk' ? 'Possible risk' : 'Worth checking'}
                  </Badge>
                </div>
                <p className="text-sm">{signal.why}</p>
                <div className="text-sm">
                  <p className="font-medium">What Prego found</p>
                  <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                    {signal.evidence.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </div>
                <p className="text-xs text-muted-foreground">May be relevant to: {signal.laws.join('; ')}.</p>
              </li>
            ))}
          </ul>
        )}
        {(legal.clear.length > 0 || legal.notChecked.length > 0) && (
          <details className="text-sm">
            <summary className="cursor-pointer font-medium">What else was looked at</summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              {legal.clear.length > 0 && (
                <div>
                  <p className="font-medium">No signs found</p>
                  <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                    {legal.clear.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </div>
              )}
              {legal.notChecked.length > 0 && (
                <div>
                  <p className="flex items-center gap-1 font-medium">
                    <Info className="size-4" aria-hidden="true" /> Not checked in this audit
                  </p>
                  <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                    {legal.notChecked.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
