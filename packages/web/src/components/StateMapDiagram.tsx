import { useMemo } from 'react';
import { Background, Controls, MarkerType, Position, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { layoutStateMap, NODE_HEIGHT, NODE_WIDTH, type MapEdge, type MapState } from '@prego/core/layout';
import { cn } from '@/lib/utils';

export interface DiagramState extends MapState {
  /** Open tickets on this screen. */
  issues?: number;
  /** Highlight the screen, e.g. for a usability problem of its own (dead end, broken button). */
  flagged?: boolean;
}

interface Props {
  states: DiagramState[];
  edges: MapEdge[];
  selected?: number | null;
  onSelect?: (id: number) => void;
  /** Show every route between screens, not just the first route to each. */
  showAll?: boolean;
  /** Short label for assistive technology, e.g. "State map of 16 screens". */
  label: string;
  height?: number;
}

/** The explored screens as a diagram: columns are taps from the start screen. */
export function StateMapDiagram({ states, edges, selected, onSelect, showAll = false, label, height = 520 }: Props) {
  const layout = useMemo(() => layoutStateMap(states, edges), [states, edges]);
  const issues = useMemo(() => new Map(states.map((s) => [s.id, s.issues ?? 0])), [states]);
  const flagged = useMemo(() => new Set(states.filter((s) => s.flagged).map((s) => s.id)), [states]);

  const nodes: Node[] = layout.states.map((s) => ({
    id: String(s.id),
    position: { x: s.x, y: s.y },
    data: { label: <NodeLabel title={s.title} depth={s.depth} issues={issues.get(s.id) ?? 0} /> },
    ariaLabel: `${s.title}, ${s.depth} ${s.depth === 1 ? 'tap' : 'taps'} from the start, ${issues.get(s.id) ?? 0} issues${flagged.has(s.id) ? ', has a usability problem' : ''}`,
    selected: selected === s.id,
    draggable: false,
    connectable: false,
    // Columns run left to right, so lines leave from the right and arrive on the left.
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    style: { width: NODE_WIDTH, height: NODE_HEIGHT, padding: 0, borderRadius: 8 },
    className: cn(
      '!bg-background !text-foreground',
      flagged.has(s.id) ? '!border-2 !border-destructive' : '!border !border-border',
      selected === s.id && '!ring-2 !ring-primary !ring-offset-2',
    ),
  }));
  const links: Edge[] = layout.links
    .filter((l) => showAll || l.tree)
    .map((l, i) => ({
      id: `${l.from}-${l.to}-${i}`,
      source: String(l.from),
      target: String(l.to),
      label: l.tree ? l.label : undefined,
      ariaLabel: `${l.label} leads to another screen`,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      style: l.tree ? { strokeWidth: 1.5 } : { strokeDasharray: '4 4', opacity: 0.5 },
      labelStyle: { fontSize: 11 },
      labelBgStyle: { fill: 'var(--background)' },
    }));

  return (
    <div role="group" aria-label={label} style={{ height }} className="rounded-md border bg-muted/40">
      <ReactFlow
        nodes={nodes}
        edges={links}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.2}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        onNodeClick={(_event, node) => onSelect?.(Number(node.id))}
        proOptions={{ hideAttribution: false }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function NodeLabel({ title, depth, issues }: { title: string; depth: number; issues: number }) {
  return (
    <div className="flex h-full flex-col justify-center px-3 text-left">
      <span className="truncate text-sm font-semibold">{title}</span>
      <span className="text-xs text-muted-foreground">
        {depth} {depth === 1 ? 'tap' : 'taps'} · {issues === 0 ? 'no issues' : `${issues} ${issues === 1 ? 'issue' : 'issues'}`}
      </span>
    </div>
  );
}
