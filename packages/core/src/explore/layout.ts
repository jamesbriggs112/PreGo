// Layout for state map diagrams, shared by the GUI and the report. No Node imports: the web app uses it.

export interface MapState {
  id: number;
  title: string;
  depth: number;
  /** Keys of the steps from the start screen. */
  stepKeys: string[];
}

export interface MapEdge {
  from: number;
  to: number | null;
  label: string;
  outcome: string;
}

export interface PlacedState extends MapState {
  x: number;
  y: number;
}

export interface MapLink {
  from: number;
  to: number;
  label: string;
  /** The first route to the screen (true) or another way to reach it (false). */
  tree: boolean;
}

export interface MapLayout {
  states: PlacedState[];
  links: MapLink[];
  width: number;
  height: number;
}

export const NODE_WIDTH = 210;
export const NODE_HEIGHT = 64;
const COLUMN_GAP = 90;
const ROW_GAP = 26;

/**
 * A tree laid out left to right: columns are taps from the start, and each screen's descendants get
 * their own block of rows, with the screen level with its first child. Routes to children therefore
 * never cross each other. Links are the first route to each screen, plus every other navigation
 * between different screens.
 */
export function layoutStateMap(states: MapState[], edges: MapEdge[]): MapLayout {
  const byPath = new Map(states.map((s) => [s.stepKeys.join('>'), s]));
  const parentOf = (s: MapState) => (s.depth === 0 ? undefined : byPath.get(s.stepKeys.slice(0, -1).join('>')));
  const ordered = [...states].sort((a, b) => a.depth - b.depth || a.id - b.id);
  const children = new Map<number, MapState[]>();
  const roots: MapState[] = [];
  for (const state of ordered) {
    const parent = parentOf(state);
    if (parent) children.set(parent.id, [...(children.get(parent.id) ?? []), state]);
    else roots.push(state);
  }

  const placed: PlacedState[] = [];
  let nextRow = 0;
  const place = (state: MapState): number => {
    const kids = children.get(state.id) ?? [];
    const row = kids.length ? kids.map(place)[0] : nextRow++;
    placed.push({ ...state, x: state.depth * (NODE_WIDTH + COLUMN_GAP), y: row * (NODE_HEIGHT + ROW_GAP) });
    return row;
  };
  roots.forEach(place);
  placed.sort((a, b) => a.depth - b.depth || a.y - b.y);
  const height = Math.max(0, nextRow * (NODE_HEIGHT + ROW_GAP) - ROW_GAP);

  const links: MapLink[] = [];
  const seen = new Set<string>();
  for (const state of states) {
    if (state.depth === 0) continue;
    const parent = byPath.get(state.stepKeys.slice(0, -1).join('>'));
    const edge = parent && edges.find((e) => e.from === parent.id && e.to === state.id && e.outcome === 'navigated');
    if (parent) {
      links.push({ from: parent.id, to: state.id, label: edge?.label ?? '', tree: true });
      seen.add(`${parent.id}>${state.id}`);
    }
  }
  for (const edge of edges) {
    if (edge.outcome !== 'navigated' || edge.to === null || edge.to === edge.from) continue;
    const key = `${edge.from}>${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ from: edge.from, to: edge.to, label: edge.label, tree: false });
  }
  const maxDepth = Math.max(0, ...states.map((s) => s.depth));
  return { states: placed, links, width: (maxDepth + 1) * (NODE_WIDTH + COLUMN_GAP) - COLUMN_GAP, height };
}
