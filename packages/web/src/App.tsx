import { useEffect, useRef } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router';
import { cn } from '@/lib/utils';
import { ProjectsPage } from '@/pages/ProjectsPage';
import { Logo } from '@/components/Logo';
import { ThemeToggle } from '@/components/ThemeToggle';
import { NewAuditPage } from '@/pages/NewAuditPage';
import { RunPage } from '@/pages/RunPage';
import { TicketPage } from '@/pages/TicketPage';
import { ExportPage } from '@/pages/ExportPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { StateMapPage } from '@/pages/StateMapPage';
import { NotFoundPage } from '@/pages/NotFoundPage';

const NAV = [
  { to: '/', label: 'Projects', end: true },
  { to: '/audits/new', label: 'New audit', end: false },
  { to: '/settings', label: 'Settings', end: false },
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
      <header className="sticky top-0 z-40 border-b border-border/70 bg-card/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-8 px-6">
          <NavLink to="/" aria-label="Prego projects">
            <Logo />
          </NavLink>
          <nav aria-label="Main">
            <ul className="flex gap-1 rounded-full bg-muted p-1">
              {NAV.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      cn(
                        'block rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                        isActive ? 'bg-card text-[var(--brand-text)] shadow-sm' : 'text-muted-foreground hover:text-foreground',
                      )
                    }
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <ThemeToggle className="ml-auto" />
        </div>
      </header>
      <main id="main" ref={main} tabIndex={-1} className="mx-auto max-w-7xl px-6 py-8 outline-none">
        <Routes>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/projects" element={<Navigate to="/" replace />} />
          <Route path="/audits/new" element={<NewAuditPage />} />
          <Route path="/runs/:runId" element={<RunPage />} />
          <Route path="/runs/:runId/tickets/:ticketId" element={<TicketPage />} />
          <Route path="/runs/:runId/export" element={<ExportPage />} />
          <Route path="/runs/:runId/map" element={<StateMapPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  );
}
