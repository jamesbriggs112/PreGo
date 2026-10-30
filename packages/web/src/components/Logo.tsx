import { useId } from 'react';
import { cn } from '@/lib/utils';

/** Prego's mark: a lens with a tick in it, inspecting and checking. Decorative; pair with the name. */
export function LogoMark({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 48 48" className={cn('size-8 shrink-0', className)} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5B5BF0" />
          <stop offset="1" stopColor="#8B5CF6" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill={`url(#${id})`} />
      <circle cx="21.5" cy="21.5" r="10" fill="none" stroke="#fff" strokeWidth="3.6" />
      <path d="M29 29l7.5 7.5" stroke="#fff" strokeWidth="4" strokeLinecap="round" />
      <path d="M16.8 21.8l3.3 3.3 6.2-6.6" fill="none" stroke="#FFC94D" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <LogoMark />
      <span className="text-[19px] font-bold tracking-tight text-foreground">Prego</span>
    </span>
  );
}
