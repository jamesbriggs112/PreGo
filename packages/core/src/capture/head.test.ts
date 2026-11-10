import { describe, expect, it } from 'vitest';
import { bestIcon, type HeadIcon } from './head.js';

const icon = (href: string, rel = 'icon', sizes: string | null = null, type: string | null = null): HeadIcon => ({ href, rel, sizes, type });

describe('choosing the site icon', () => {
  it('prefers SVG, then a PNG of 32px or more, then the touch icon, then anything', () => {
    const small = icon('https://x.test/16.png', 'icon', '16x16');
    const big = icon('https://x.test/32.png', 'icon', '32x32');
    const touch = icon('https://x.test/touch.png', 'apple-touch-icon');
    const svg = icon('https://x.test/icon.svg', 'icon', null, 'image/svg+xml');
    expect(bestIcon([small, big, touch, svg])).toBe(svg);
    expect(bestIcon([small, big, touch])).toBe(big);
    expect(bestIcon([small, touch])).toBe(touch);
    expect(bestIcon([small])).toBe(small);
    expect(bestIcon([])).toBeNull();
  });
});
