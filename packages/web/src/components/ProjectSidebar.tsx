import { NavLink } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { FolderOpen, Info, SquarePen } from 'lucide-react';
import { api, type ProjectListItem } from '@/lib/api';
import { cn, formatDateTime } from '@/lib/utils';
import { Logo } from '@/components/Logo';

/** Where a project in the sidebar goes: its latest audit, or a new audit if it has none. */
const projectLink = (p: ProjectListItem) => (p.lastRun ? `/runs/${p.lastRun.id}` : `/audits/new?project=${encodeURIComponent(p.name)}`);

const RECENT = 10;

/** Most recently audited first; projects with no audits yet go by when they were added. */
const lastActive = (p: ProjectListItem) => p.lastRun?.startedAt ?? p.createdAt;

/** The left-hand column: Prego's name, a way back to the set-up box, and every project. */
export function ProjectSidebar({ onNavigate }: { onNavigate?: () => void }) {
  // Refreshed now and then, so running audits move to Complete without a reload.
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects, refetchInterval: 15_000 });
  const recent = [...(projects.data ?? [])].sort((a, b) => lastActive(b).localeCompare(lastActive(a))).slice(0, RECENT);
  const item = ({ isActive }: { isActive: boolean }) =>
    cn('flex items-center gap-2 rounded-lg px-3 py-2 text-sm', isActive ? 'bg-secondary font-medium text-secondary-foreground' : 'hover:bg-muted');

  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <NavLink to="/" aria-label="Prego home" className="px-2 py-1.5" onClick={onNavigate}>
        <Logo />
      </NavLink>
      <NavLink to="/" end className={item} onClick={onNavigate}>
        <SquarePen aria-hidden="true" className="size-4" /> Set up an audit
      </NavLink>
      <nav aria-label="Projects" className="flex min-h-0 flex-1 flex-col">
        <h2 className="px-3 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Recent projects</h2>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {projects.isPending && <p className="px-3 py-2 text-sm text-muted-foreground">Loading…</p>}
          {projects.isError && <p className="px-3 py-2 text-sm text-destructive">Couldn’t load projects.</p>}
          {projects.data?.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">No projects yet. Describe an audit to start one.</p>}
          <ul className="grid gap-0.5">
            {recent.map((p) => (
              <li key={p.id}>
                <NavLink to={projectLink(p)} className={({ isActive }) => cn(item({ isActive }), 'grid gap-0')} onClick={onNavigate}>
                  <span className="truncate">{p.name}</span>
                  <span className="truncate text-xs font-normal text-muted-foreground">
                    {p.lastRun ? `${p.lastRun.status === 'running' ? 'Auditing now' : `Last audit ${formatDateTime(p.lastRun.startedAt)}`}` : 'No audits yet'}
                  </span>
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      </nav>
      <div className="grid gap-0.5">
        <NavLink to="/projects" className={item} onClick={onNavigate}>
          <FolderOpen aria-hidden="true" className="size-4" /> All projects{projects.data && projects.data.length > RECENT ? ` (${projects.data.length})` : ''}
        </NavLink>
        <NavLink to="/about" className={item} onClick={onNavigate}>
          <Info aria-hidden="true" className="size-4" /> About Prego
        </NavLink>
      </div>
    </div>
  );
}
