import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold whitespace-nowrap', {
  variants: {
    variant: {
      default: 'border-transparent bg-primary text-primary-foreground',
      secondary: 'border-transparent bg-secondary text-secondary-foreground',
      outline: 'text-foreground',
      critical: 'border-transparent bg-destructive text-destructive-foreground',
      high: 'border-transparent bg-[oklch(0.5_0.15_45)] text-white',
      medium: 'border-transparent bg-[oklch(0.88_0.1_85)] text-[oklch(0.3_0.06_70)]',
      low: 'border-transparent bg-secondary text-secondary-foreground',
      success: 'border-transparent bg-success text-white',
    },
  },
  defaultVariants: { variant: 'default' },
});

export function Badge({ className, variant, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
