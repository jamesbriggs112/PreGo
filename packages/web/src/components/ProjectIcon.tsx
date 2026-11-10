import type { Project } from '@prego/core/types';
import { cn } from '@/lib/utils';

/** The site's own icon, saved from its home page, or the project's first letter. Decorative: the name is always next to it. */
export function ProjectIcon({ project, className }: { project: Pick<Project, 'name' | 'settings'>; className?: string }) {
  const icon = project.settings.icon?.dataUrl;
  return (
    <span aria-hidden="true" className={cn('grid size-5 shrink-0 place-items-center overflow-hidden rounded-md bg-muted text-[0.65rem] font-semibold text-muted-foreground', className)}>
      {icon ? <img src={icon} alt="" className="size-full object-contain" /> : project.name.trim()[0]?.toUpperCase()}
    </span>
  );
}
