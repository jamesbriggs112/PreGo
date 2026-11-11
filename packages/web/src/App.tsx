import { useEffect, useRef, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router';
import { Menu, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { HomePage } from '@/pages/HomePage';
import { AboutPage } from '@/pages/AboutPage';
import { ProjectsPage } from '@/pages/ProjectsPage';
import { AudiencePage } from '@/pages/AudiencePage';
import { ClientPage } from '@/pages/ClientPage';
import { ProjectSidebar } from '@/components/ProjectSidebar';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Button } from '@/components/ui/button';
import { NewAuditPage } from '@/pages/NewAuditPage';
import { RunPage } from '@/pages/RunPage';
import { TicketPage } from '@/pages/TicketPage';
import { ExportPage } from '@/pages/ExportPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { StateMapPage } from '@/pages/StateMapPage';
import { NotFoundPage } from '@/pages/NotFoundPage';

const NAV = [
  { to: '/projects', label: 'Projects' },
  { to: '/audits/new', label: 'New audit' },
  { to: '/settings', label: 'Settings' },
];

export function App() {
  const location = useLocation();
  const main = useRef<HTMLElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
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
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2">
        Skip to main content
      </a>

      {/* Projects down the left. On small screens it opens from the menu button. */}
      <aside
        id="sidebar"
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-72 border-r border-border/70 bg-card md:sticky md:top-0 md:z-auto md:block md:h-screen md:w-64 md:shrink-0',
          menuOpen ? 'block' : 'hidden',
        )}
      >
        {menuOpen && (
          <Button variant="ghost" size="icon" className="absolute top-3 right-3 md:hidden" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
            <X aria-hidden="true" />
          </Button>
        )}
        <ProjectSidebar onNavigate={() => setMenuOpen(false)} />
      </aside>
      {menuOpen && <div className="fixed inset-0 z-40 bg-black/40 md:hidden" aria-hidden="true" onClick={() => setMenuOpen(false)} />}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 bg-background/90 px-4 backdrop-blur md:px-6">
          <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu" aria-expanded={menuOpen} aria-controls="sidebar" onClick={() => setMenuOpen(true)}>
            <Menu aria-hidden="true" />
          </Button>
          <nav aria-label="Main" className="ml-auto">
            <ul className="flex gap-0.5 sm:gap-1">
              {NAV.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    className={({ isActive }) =>
                      cn(
                        'block rounded-full px-2.5 py-1.5 text-sm font-medium whitespace-nowrap sm:px-4',
                        isActive ? 'bg-card text-[var(--brand-text)] shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      )
                    }
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <ThemeToggle />
        </header>
        <main id="main" ref={main} tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 pt-4 pb-10 outline-none md:px-8">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/:projectId/audience" element={<AudiencePage />} />
            <Route path="/projects/:projectId/client" element={<ClientPage />} />
            <Route path="/audits/new" element={<NewAuditPage />} />
            <Route path="/runs/:runId" element={<RunPage />} />
            <Route path="/runs/:runId/tickets/:ticketId" element={<TicketPage />} />
            <Route path="/runs/:runId/export" element={<ExportPage />} />
            <Route path="/runs/:runId/map" element={<StateMapPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
