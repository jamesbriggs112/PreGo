import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// Soft fills with text of the same hue (tokens in index.css, one set per theme): AA contrast to read.
const badgeVariants = cva('inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap', {
  variants: {
    variant: {
      default: 'border-transparent bg-primary text-primary-foreground',
      brand: 'border-transparent bg-[var(--badge-brand-bg)] text-[var(--badge-brand-fg)]',
      secondary: 'border-transparent bg-secondary text-secondary-foreground',
      outline: 'border-border bg-card text-foreground',
      critical: 'border-transparent bg-[var(--badge-critical-bg)] text-[var(--badge-critical-fg)]',
      'critical-soft': 'border-transparent bg-[var(--badge-critical-bg)] text-[var(--badge-critical-fg)]',
      high: 'border-transparent bg-[var(--badge-high-bg)] text-[var(--badge-high-fg)]',
      medium: 'border-transparent bg-[var(--badge-medium-bg)] text-[var(--badge-medium-fg)]',
      low: 'border-transparent bg-[var(--badge-brand-bg)] text-[var(--badge-brand-fg)]',
      success: 'border-transparent bg-[var(--badge-success-bg)] text-[var(--badge-success-fg)]',
    },
  },
  defaultVariants: { variant: 'default' },
});

export function Badge({ className, variant, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
