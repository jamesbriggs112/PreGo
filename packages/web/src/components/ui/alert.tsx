import * as React from 'react';
import { cn } from '@/lib/utils';

export function Alert({ className, variant = 'default', ...props }: React.HTMLAttributes<HTMLDivElement> & { variant?: 'default' | 'destructive' }) {
  return (
    <div
      className={cn(
        'rounded-lg border px-4 py-3 text-sm',
        variant === 'destructive' ? 'border-destructive/50 bg-destructive/5 text-destructive' : 'bg-background',
        className,
      )}
      {...props}
    />
  );
}
