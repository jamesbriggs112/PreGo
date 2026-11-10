import { useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCopy, Download, FolderOpen, Info, Pin, PinOff, Play, RotateCw, SquarePen, Trash2, Users } from 'lucide-react';
import { api, type ProjectListItem } from '@/lib/api';
import { cn, formatDateTime } from '@/lib/utils';
import { Logo } from '@/components/Logo';
import { ProjectContextMenu, ProjectMenuButton, type MenuAction } from '@/components/ProjectMenu';
import { DeleteProjectDialog } from '@/components/DeleteProjectDialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** Where a project in the sidebar goes: its latest audit, or a new audit if it has none. */
const projectLink = (p: ProjectListItem) => (p.lastRun ? `/runs/${p.lastRun.id}` : `/audits/new?project=${encodeURIComponent(p.name)}`);

const RECENT = 10;

/** Most recently audited first; projects with no audits yet go by when they were added. */
const lastActive = (p: ProjectListItem) => p.lastRun?.startedAt ?? p.createdAt;

/** The left-hand column: Prego's name, a way back to the set-up box, pinned and recent projects. Right-click a project for its menu. */
export function ProjectSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  // Refreshed now and then, so running audits move to Complete without a reload.
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects, refetchInterval: 15_000 });
  const pinned = (projects.data ?? []).filter((p) => p.settings.pinned).sort((a, b) => a.name.localeCompare(b.name));
  const recent = [...(projects.data ?? [])]
    .filter((p) => !p.settings.pinned)
    .sort((a, b) => lastActive(b).localeCompare(lastActive(a)))
    .slice(0, RECENT);
  const [deleting, setDeleting] = useState<ProjectListItem | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const go = (to: string) => {
    navigate(to);
    onNavigate?.();
  };
  const pin = useMutation({
    mutationFn: ({ id, on }: { id: number; on: boolean }) => api.pinProject(id, on),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
    onError: (error) => setProblem(error.message),
  });
  const rerun = useMutation({
    mutationFn: (runId: number) => api.rerun(runId),
    onSuccess: async ({ runId }) => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      go(`/runs/${runId}`);
    },
    onError: (error) => setProblem(error.message),
  });

  const actionsFor = (p: ProjectListItem): MenuAction[] => {
    const last = p.lastRun;
    const running = last?.status === 'running';
    const complete = last?.status === 'complete';
    const isUrl = !!last && /^https?:\/\//.test(last.target);
    return [
      ...(last ? [{ kind: 'item' as const, label: running ? 'Watch the audit' : 'Open latest audit', icon: <FolderOpen />, onSelect: () => go(`/runs/${last.id}`) }] : []),
      ...(last ? [{ kind: 'item' as const, label: 'Audit again with the same settings', icon: <RotateCw />, onSelect: () => rerun.mutate(last.id), disabled: running || rerun.isPending }] : []),
      { kind: 'item', label: 'New audit for this project', icon: <Play />, onSelect: () => go(`/audits/new?project=${encodeURIComponent(p.name)}`) },
      ...(complete ? [{ kind: 'item' as const, label: 'Export report and tickets', icon: <Download />, onSelect: () => go(`/runs/${last.id}/export`) }] : []),
      { kind: 'item', label: 'Purposes and audience', icon: <Users />, onSelect: () => go(`/projects/${p.id}/audience`) },
      { kind: 'separator' },
      p.settings.pinned
        ? { kind: 'item', label: 'Unpin', icon: <PinOff />, onSelect: () => pin.mutate({ id: p.id, on: false }) }
        : { kind: 'item', label: 'Pin to the top', icon: <Pin />, onSelect: () => pin.mutate({ id: p.id, on: true }) },
      ...(isUrl ? [{ kind: 'item' as const, label: 'Copy the site address', icon: <ClipboardCopy />, onSelect: () => void navigator.clipboard?.writeText(last.target) }] : []),
      { kind: 'separator' },
      { kind: 'item', label: 'Delete project…', icon: <Trash2 />, destructive: true, onSelect: () => setDeleting(p), disabled: running },
    ];
  };

  const item = ({ isActive }: { isActive: boolean }) =>
    cn('flex items-center gap-2 rounded-lg px-3 py-2 text-sm', isActive ? 'bg-secondary font-medium text-secondary-foreground' : 'hover:bg-muted');

  const row = (p: ProjectListItem) => {
    const actions = actionsFor(p);
    return (
      <li key={p.id} className="group relative">
        {/* The menu wraps a plain element: passing NavLink's class function through the trigger would turn it into text. */}
        <ProjectContextMenu actions={actions}>
          <div>
            <NavLink to={projectLink(p)} className={({ isActive }) => cn(item({ isActive }), 'grid gap-0 pr-9')} onClick={onNavigate}>
              <span className="flex items-center gap-1 truncate">
                {p.settings.pinned && <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />}
                <span className="truncate">{p.name}</span>
              </span>
              <span className="truncate text-xs font-normal text-muted-foreground">
                {p.lastRun ? `${p.lastRun.status === 'running' ? 'Auditing now' : `Last audit ${formatDateTime(p.lastRun.startedAt)}`}` : 'No audits yet'}
              </span>
            </NavLink>
          </div>
        </ProjectContextMenu>
        <ProjectMenuButton
          actions={actions}
          label={`More actions for ${p.name}`}
          className="absolute top-1/2 right-1.5 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
        />
      </li>
    );
  };

  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <NavLink to="/" aria-label="Prego home" className="px-2 py-1.5" onClick={onNavigate}>
        <Logo />
      </NavLink>
      <NavLink to="/" end className={item} onClick={onNavigate}>
        <SquarePen aria-hidden="true" className="size-4" /> Set up an audit
      </NavLink>
      <nav aria-label="Projects" className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {pinned.length > 0 && (
            <>
              <h2 className="px-3 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Pinned</h2>
              <ul className="mb-3 grid gap-0.5">{pinned.map(row)}</ul>
            </>
          )}
          <h2 className="px-3 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Recent projects</h2>
          {projects.isPending && <p className="px-3 py-2 text-sm text-muted-foreground">Loading…</p>}
          {projects.isError && <p className="px-3 py-2 text-sm text-destructive">Couldn’t load projects.</p>}
          {projects.data?.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">No projects yet. Describe an audit to start one.</p>}
          <ul className="grid gap-0.5">{recent.map(row)}</ul>
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

      {deleting && (
        <DeleteProjectDialog
          project={deleting}
          onClose={() => setDeleting(null)}
          // If you were looking at the deleted project, go back to the start.
          onDeleted={() => {
            const viewing = location.pathname.startsWith(`/projects/${deleting.id}/`) || (!!deleting.lastRun && location.pathname.startsWith(`/runs/${deleting.lastRun.id}`));
            if (viewing) go('/');
          }}
        />
      )}
      <Dialog open={!!problem} onOpenChange={(open) => !open && setProblem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>That didn’t work</DialogTitle>
            <DialogDescription>{problem}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setProblem(null)}>OK</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
