import type { Location, PathStep, StateEdge } from '../../types.js';
import type { CheckFinding, CheckModule } from '../types.js';
import { guidanceFor } from '../guidance.js';

export interface StateMapGraph {
  locations: Location[];
  edges: StateEdge[];
}

export interface StateMapOptions {
  /** Screens more than this many taps from the start are flagged. Default 4. */
  maxTaps?: number;
  /** Report only at this viewport: the map doesn't change with screen size, so once is enough. */
  viewport?: string;
}

const HOME = /^(home|main menu|start|start again)$/i;
const BACK = /^(back|go back|previous)$/i;

/**
 * UX findings from an explored state map: dead ends, actions that do nothing, content buried too
 * deep, and Home or Back buttons that behave differently from screen to screen.
 */
export function stateMapModule(graph: StateMapGraph, options: StateMapOptions = {}): CheckModule {
  const findingsByLocation = analyseStateMap(graph, options);
  return {
    id: 'state-map',
    name: 'Usability (state map)',
    async run({ location, viewport }) {
      if (options.viewport && viewport !== options.viewport) return [];
      return findingsByLocation.get(location.id) ?? [];
    },
  };
}

/** The state map findings for every screen, keyed by location ID. */
export function analyseStateMap({ locations, edges }: StateMapGraph, options: StateMapOptions = {}): Map<number, CheckFinding[]> {
  const maxTaps = options.maxTaps ?? 4;
  const states = locations.filter((l) => l.kind === 'state');
  const byId = new Map(states.map((l) => [l.id, l]));
  const from = (id: number) => edges.filter((e) => e.fromLocationId === id);
  const result = new Map<number, CheckFinding[]>();
  const add = (location: Location, finding: CheckFinding) => result.set(location.id, [...(result.get(location.id) ?? []), finding]);

  // Where each action label leads when it does navigate, to recognise expected "stay here" presses
  // (Home on the home screen) and inconsistent ones (Home going different places).
  const destinations = new Map<string, Map<number, number>>();
  for (const e of edges) {
    if (e.outcome !== 'navigated' || e.toLocationId === null || e.toLocationId === e.fromLocationId) continue;
    const label = normalise(e.step.label);
    const counts = destinations.get(label) ?? new Map<number, number>();
    counts.set(e.toLocationId, (counts.get(e.toLocationId) ?? 0) + 1);
    destinations.set(label, counts);
  }
  // The screen reached by each path, to know where Back should go.
  const byPath = new Map(states.map((l) => [pathKey(l.steps ?? []), l]));

  for (const state of states) {
    const out = from(state.id);
    const waysOut = out.filter((e) => e.outcome === 'navigated' && e.toLocationId !== state.id);
    const uncertain = out.some((e) => e.outcome === 'limit' || e.outcome === 'failed');

    if (state.depth > 0 && waysOut.length === 0 && !uncertain) {
      const skipped = out.filter((e) => e.outcome === 'skipped' || e.outcome === 'external');
      add(state, finding('dead-end', 'High', 'html', '<html>', skipped.length
        ? `Only ${skipped.map((e) => `"${e.step.label}"`).join(', ')} remained, which Prego doesn't press (${skipped[0].reason}).`
        : out.length === 0 ? 'The screen has nothing to press.' : 'Every control on the screen leaves it unchanged.'));
    }

    for (const e of out) {
      if (e.outcome !== 'unchanged') continue;
      // Pressing Home on the home screen is expected to do nothing.
      if (destinations.get(normalise(e.step.label))?.has(state.id)) continue;
      add(state, finding('no-op-action', 'Medium', e.step.selector, `<${e.step.role}> ${e.step.label}`, `Pressing "${e.step.label}" changed nothing on the screen.`));
    }

    if (state.depth > maxTaps) {
      add(state, finding('deep-content', 'Low', 'html', '<html>', `This screen is ${state.depth} taps from the start; the limit is ${maxTaps}.`));
    }

    for (const e of waysOut) {
      const label = normalise(e.step.label);
      if (HOME.test(e.step.label)) {
        const counts = destinations.get(label)!;
        const usual = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        if (counts.size > 1 && e.toLocationId !== usual) {
          add(state, finding('inconsistent-navigation', 'Medium', e.step.selector, `<${e.step.role}> ${e.step.label}`,
            `"${e.step.label}" here goes to "${byId.get(e.toLocationId!)?.title}", but from most screens it goes to "${byId.get(usual)?.title}".`));
        }
      } else if (BACK.test(e.step.label) && state.steps && state.steps.length > 0) {
        const previous = byPath.get(pathKey(state.steps.slice(0, -1)));
        if (previous && e.toLocationId !== previous.id) {
          add(state, finding('inconsistent-navigation', 'Medium', e.step.selector, `<${e.step.role}> ${e.step.label}`,
            `"${e.step.label}" goes to "${byId.get(e.toLocationId!)?.title}", not back to "${previous.title}", the screen it was reached from.`));
        }
      }
    }
  }
  return result;
}

function finding(ruleId: string, severity: CheckFinding['severity'], selector: string, html: string, failureSummary: string): CheckFinding {
  const guidance = guidanceFor('prego', ruleId)!;
  return {
    module: 'state-map',
    engine: 'prego',
    ruleId,
    category: 'UX',
    severity,
    title: guidance.title,
    description: guidance.description,
    helpUrl: null,
    wcagCriteria: [],
    wcagLevel: null,
    selector,
    html,
    failureSummary,
  };
}

const normalise = (label: string) => label.trim().toLowerCase();
const pathKey = (steps: PathStep[]) => steps.map((s) => s.key).join(' > ');
