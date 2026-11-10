import type { ReactNode } from 'react';
import { ContextMenu, DropdownMenu } from 'radix-ui';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

// One list of actions for a project, shown two ways: by right-clicking its row in the sidebar, and
// from a "More actions" button on the row, so keyboard and screen reader users get the same menu.

export type MenuAction =
  | { kind: 'item'; label: string; icon: ReactNode; onSelect: () => void; destructive?: boolean; disabled?: boolean }
  | { kind: 'separator' };

const itemClass = (destructive?: boolean) =>
  cn(
    'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none',
    'data-[highlighted]:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
    destructive ? 'text-destructive' : '',
  );
const contentClass = 'z-50 min-w-52 rounded-lg border bg-card p-1 text-card-foreground shadow-lg';

/** Right-clicking `children` opens the menu. */
export function ProjectContextMenu({ actions, children }: { actions: MenuAction[]; children: ReactNode }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={contentClass}>
          {actions.map((a, i) =>
            a.kind === 'separator' ? (
              <ContextMenu.Separator key={i} className="my-1 h-px bg-border" />
            ) : (
              <ContextMenu.Item key={a.label} className={itemClass(a.destructive)} onSelect={a.onSelect} disabled={a.disabled}>
                {a.icon}
                {a.label}
              </ContextMenu.Item>
            ),
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** A small button that opens the same menu. */
export function ProjectMenuButton({ actions, label, className }: { actions: MenuAction[]; label: string; className?: string }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label={label}
        className={cn(
          'grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring data-[state=open]:bg-background',
          className,
        )}
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={contentClass} align="start" side="right">
          {actions.map((a, i) =>
            a.kind === 'separator' ? (
              <DropdownMenu.Separator key={i} className="my-1 h-px bg-border" />
            ) : (
              <DropdownMenu.Item key={a.label} className={itemClass(a.destructive)} onSelect={a.onSelect} disabled={a.disabled}>
                {a.icon}
                {a.label}
              </DropdownMenu.Item>
            ),
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
