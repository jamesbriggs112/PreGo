import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// Pastel fills with dark text of the same hue: soft to look at, AA contrast to read.
const badgeVariants = cva('inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap', {
  variants: {
    variant: {
      default: 'border-transparent bg-primary text-primary-foreground',
      brand: 'border-transparent bg-[var(--brand-50)] text-[var(--brand-700)]',
      secondary: 'border-transparent bg-secondary text-secondary-foreground',
      outline: 'border-border bg-card text-foreground',
      critical: 'border-transparent bg-[#fde8ec] text-[#a3122e]',
      'critical-soft': 'border-transparent bg-[#fde8ec] text-[#a3122e]',
      high: 'border-transparent bg-[#ffeedd] text-[#8f3f00]',
      medium: 'border-transparent bg-[#fff4d1] text-[#6e4d00]',
      low: 'border-transparent bg-[var(--brand-50)] text-[var(--brand-700)]',
      success: 'border-transparent bg-[#dcf6ee] text-[#0b5e4b]',
    },
  },
  defaultVariants: { variant: 'default' },
});

export function Badge({ className, variant, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
