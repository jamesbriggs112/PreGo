import { Moon, Sun } from 'lucide-react';
import { setTheme, useTheme } from '@/lib/theme';
import { Button } from '@/components/ui/button';

export function ThemeToggle({ className }: { className?: string }) {
  const theme = useTheme();
  const dark = theme === 'dark';
  return (
    <Button variant="ghost" size="icon" className={className} aria-label="Dark mode" aria-pressed={dark} onClick={() => setTheme(dark ? 'light' : 'dark')}>
      {dark ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
    </Button>
  );
}
