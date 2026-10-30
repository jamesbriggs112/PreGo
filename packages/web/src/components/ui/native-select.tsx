import * as React from 'react';
import { cn } from '@/lib/utils';

/** A styled native <select>: fully keyboard and screen reader accessible with no extra work. */
export function NativeSelect({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn('flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs disabled:cursor-not-allowed disabled:opacity-50', className)}
      {...props}
    />
  );
}
