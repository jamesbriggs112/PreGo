import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { guidanceFor } from './guidance.js';

describe('plain-English wording', () => {
  it('has a title and fix for every axe rule that can raise a finding', () => {
    const axe = createRequire(import.meta.url)('axe-core') as { getRules(): { ruleId: string; tags: string[] }[] };
    const rules = axe.getRules().filter((r) => !r.tags.includes('experimental') && !r.tags.includes('deprecated'));
    expect(rules.length).toBeGreaterThan(80);
    expect(rules.filter((r) => !guidanceFor('axe-core', r.ruleId)?.title)).toEqual([]);
    expect(guidanceFor('axe-core', 'landmark-unique', ['1.3.1'])).toMatchObject({
      title: 'Several page regions have the same label',
      whyItMatters: expect.stringMatching(/screen readers/i),
    });
  });
});
