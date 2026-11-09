import type { AudienceProfile, Persona, PersonaDevice, Purpose, TaskSuccess, UserTask } from './types.js';

const DEVICES: PersonaDevice[] = ['mobile', 'desktop', 'tablet', 'any'];
const FORMS = ['contact', 'search', 'login', 'newsletter', 'other'] as const;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const id = (v: unknown) => str(v, 60).replace(/[^\w-]/g, '');

function success(v: unknown): TaskSuccess {
  const s = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  if (s.kind === 'page' && str(s.path, 500).startsWith('/')) return { kind: 'page', path: str(s.path, 500) };
  if (s.kind === 'contact') return { kind: 'contact' };
  if (s.kind === 'form' && FORMS.includes(s.form as (typeof FORMS)[number])) return { kind: 'form', form: s.form as (typeof FORMS)[number] };
  return { kind: 'described' };
}

/**
 * A project's purposes, personas and tasks from saved or submitted JSON. Anything without a title,
 * name or goal is dropped, IDs are made unique, and links between them that don't resolve are removed.
 */
export function parseAudienceProfile(value: unknown): AudienceProfile {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const list = (key: string) => (Array.isArray(v[key]) ? (v[key] as Record<string, unknown>[]).filter((x) => x && typeof x === 'object').slice(0, 50) : []);
  const unique = (seen: Set<string>, wanted: string, prefix: string) => {
    let out = wanted || `${prefix}-1`;
    for (let n = 2; seen.has(out); n++) out = `${wanted || prefix}-${n}`;
    seen.add(out);
    return out;
  };

  const purposeIds = new Set<string>();
  const purposes: Purpose[] = list('purposes')
    .filter((p) => str(p.title, 120))
    .map((p) => ({
      id: unique(purposeIds, id(p.id), 'purpose'),
      title: str(p.title, 120),
      description: str(p.description, 1000),
      current: p.current === true,
      intended: p.intended === true,
      priority: p.priority === 'primary' ? 'primary' : 'secondary',
      evidence: Array.isArray(p.evidence) ? p.evidence.map((e) => str(e, 200)).filter(Boolean).slice(0, 10) : [],
    }));

  const personaIds = new Set<string>();
  const personas: Persona[] = list('personas')
    .filter((p) => str(p.name, 120))
    .map((p) => ({
      id: unique(personaIds, id(p.id), 'persona'),
      name: str(p.name, 120),
      summary: str(p.summary, 1000),
      context: str(p.context, 1000),
      device: DEVICES.includes(p.device as PersonaDevice) ? (p.device as PersonaDevice) : 'any',
      accessNeeds: str(p.accessNeeds, 300),
      internal: p.internal === true,
      purposeIds: Array.isArray(p.purposeIds) ? [...new Set(p.purposeIds.map(id).filter((x) => purposeIds.has(x)))] : [],
    }));

  const taskIds = new Set<string>();
  const tasks: UserTask[] = list('tasks')
    .filter((t) => str(t.goal, 200) && personaIds.has(id(t.personaId)))
    .map((t) => ({
      id: unique(taskIds, id(t.id), 'task'),
      personaId: id(t.personaId),
      goal: str(t.goal, 200),
      doneWhen: str(t.doneWhen, 300),
      success: success(t.success),
      ...(purposeIds.has(id(t.purposeId)) && { purposeId: id(t.purposeId) }),
    }));

  return { purposes, personas, tasks, updatedAt: new Date().toISOString() };
}
