import { useState } from 'react';
import type { Project } from '@prego/core/types';
import { cn } from '@/lib/utils';

/** Address of the project's saved picture, changing whenever a new one is saved. */
export const projectIconUrl = (project: Pick<Project, 'id' | 'settings'>) => (project.settings.icon ? `/api/projects/${project.id}/icon?v=${encodeURIComponent(project.settings.icon.savedAt)}` : null);

/**
 * The site's icon, logo or share image, saved during its audits, or the project's first letter.
 * Decorative: the name is always next to it.
 */
export function ProjectIcon({ project, className }: { project: Pick<Project, 'id' | 'name' | 'settings'>; className?: string }) {
  const url = projectIconUrl(project);
  const [failed, setFailed] = useState<string | null>(null);
  const kind = project.settings.icon?.kind;
  return (
    <span aria-hidden="true" className={cn('grid size-5 shrink-0 place-items-center overflow-hidden rounded-md bg-muted text-[0.65rem] font-semibold text-muted-foreground', kind === 'logo' && failed !== url && 'bg-white', className)}>
      {url && failed !== url ? (
        <img src={url} alt="" className={cn('size-full', kind === 'share-image' ? 'object-cover' : 'object-contain')} onError={() => setFailed(url)} />
      ) : (
        project.name.trim()[0]?.toUpperCase()
      )}
    </span>
  );
}
