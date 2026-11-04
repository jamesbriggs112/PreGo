import { Link } from 'react-router';
import { CHECK_GROUPS } from '@prego/core/estimate';
import { useTitle } from '@/lib/use-title';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const STEPS = [
  { title: 'Set it up', text: 'Describe the audit on the first page, or use the New audit form for every setting.' },
  { title: 'Prego audits', text: 'It crawls the site, explores an interactive or replays a recorded journey, checking each page at every screen size.' },
  { title: 'Review', text: 'Findings are grouped into tickets with a severity and priority. Edit, merge or dismiss them before exporting.' },
  { title: 'Export', text: 'A Word report with outlined screenshots, plus tickets.csv for Productive, Jira, Linear or Trello.' },
];

const PROMISES = [
  'Everything runs on this computer. Audit data and screenshots never leave it, and nothing is sent to a paid service.',
  'Checks are passive: Prego looks at what a site serves to any visitor. It never attacks a site or probes addresses the site doesn’t link to.',
  'It follows robots.txt and opens a few pages at a time, so the client’s site isn’t put under load.',
  'Prego’s browsers can’t reach known advertising and analytics trackers, so audits don’t appear in clients’ analytics.',
  'AI review is optional and only uses Ollama running on this computer.',
  'Screenshots go into the Word report, and are deleted from Prego once it’s exported.',
];

export function AboutPage() {
  useTitle('About');
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">About Prego</h1>
        <p className="text-muted-foreground">
          Prego checks websites, single-page apps and kiosk interactives before they go live, and turns what it finds into a report and tickets the team can work
          from.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle as="h2">How an audit works</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-4 sm:grid-cols-2">
            {STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-3">
                <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-semibold text-secondary-foreground">
                  {i + 1}
                </span>
                <div>
                  <p className="font-medium">{step.title}</p>
                  <p className="text-sm text-muted-foreground">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2">What it tests</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 sm:grid-cols-2">
            {CHECK_GROUPS.map((group) => (
              <div key={group.id}>
                <dt className="font-medium">{group.name}</dt>
                <dd className="text-sm text-muted-foreground">{group.description}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2">Safe and private</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-2 pl-5 text-sm">
            {PROMISES.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2">What it can’t do</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            Automated checks find only some problems. Many accessibility criteria need a person to judge them, such as whether alt text is meaningful or the reading order
            makes sense. Reports say what the checks found; they don’t say a site meets WCAG or any other standard.
          </p>
          <p>Each report ends with the manual tests still worth doing, such as keyboard-only and screen reader passes.</p>
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        Prego is built from free, open-source tools, including Playwright, axe-core, IBM Equal Access, Lighthouse and Retire.js. Set it up in{' '}
        <Link to="/settings" className="text-primary underline">
          Settings
        </Link>
        .
      </p>
    </div>
  );
}
