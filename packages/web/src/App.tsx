import { useEffect, useRef } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router';
import { cn } from '@/lib/utils';
import { ProjectsPage } from '@/pages/ProjectsPage';
import { NewAuditPage } from '@/pages/NewAuditPage';
import { RunPage } from '@/pages/RunPage';
import { TicketPage } from '@/pages/TicketPage';
import { NotFoundPage } from '@/pages/NotFoundPage';

const NAV = [
  { to: '/', label: 'Projects', end: true },
  { to: '/audits/new', label: 'New audit', end: false },
];

export function App() {
  const location = useLocation();
  const main = useRef<HTMLElement>(null);
  // Move focus to the page on navigation, so screen reader and keyboard users start at the new content.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus();
  }, [location.pathname]);

  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2">
        Skip to main content
      </a>
      <header className="border-b bg-background">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-8 px-6">
          <NavLink to="/" className="flex items-center gap-2 text-lg font-bold text-primary">
            <img src="/favicon.svg" alt="" className="size-6" />
            Prego
          </NavLink>
          <nav aria-label="Main">
            <ul className="flex gap-1">
              {NAV.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      cn('rounded-md px-3 py-2 text-sm font-medium hover:bg-accent', isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground')
                    }
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      <main id="main" ref={main} tabIndex={-1} className="mx-auto max-w-6xl px-6 py-8 outline-none">
        <Routes>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/audits/new" element={<NewAuditPage />} />
          <Route path="/runs/:runId" element={<RunPage />} />
          <Route path="/runs/:runId/tickets/:ticketId" element={<TicketPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  );
}
