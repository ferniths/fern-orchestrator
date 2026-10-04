import { useMemo } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { FlowNode } from '@shared/ipc'
import type { WorkflowEdge } from '@shared/domain'
import { kindGlyph } from '../lib/format'

export interface OrchNodeData extends Record<string, unknown> {
  label: string
  kind: string
  state: string
  detail: string
}

type OrchNode = Node<OrchNodeData, 'orch'>

const STATE_STYLE: Record<string, { border: string; badge: string; text: string }> = {
  pending: { border: 'border-line2', badge: 'bg-panel2 text-fgf', text: 'text-fgf' },
  ready: { border: 'border-info/60', badge: 'bg-info/15 text-info', text: 'text-info' },
  running: { border: 'border-accent', badge: 'bg-accent/20 text-accent', text: 'text-accent' },
  waiting_approval: { border: 'border-warn', badge: 'bg-warn/15 text-warn', text: 'text-warn' },
  blocked: { border: 'border-warn/70', badge: 'bg-warn/10 text-warn', text: 'text-warn' },
  succeeded: { border: 'border-ok/70', badge: 'bg-ok/15 text-ok', text: 'text-ok' },
  failed: { border: 'border-danger', badge: 'bg-danger/15 text-danger', text: 'text-danger' },
  timed_out: { border: 'border-danger/60', badge: 'bg-danger/10 text-danger', text: 'text-danger' },
  skipped: { border: 'border-line2', badge: 'bg-panel2 text-fgf line-through', text: 'text-fgf' },
  cancelled: { border: 'border-line2', badge: 'bg-panel2 text-fgf', text: 'text-fgf' },
}

function OrchNodeComponent({ data, selected }: NodeProps<OrchNode>) {
  const style = STATE_STYLE[data.state] ?? STATE_STYLE.pending!
  return (
    <div
      className={`nodrag w-[190px] rounded-lg border-2 bg-panel px-2.5 py-2 shadow-lg shadow-black/40 transition-colors ${style.border} ${
        selected ? 'ring-1 ring-accent' : ''
      }`}
      data-state={data.state}
      title={data.detail || data.label}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-line2" />
      <div className="flex items-center gap-1.5">
        <span className="text-[12px] text-fgf">{kindGlyph(data.kind)}</span>
        <span className="flex-1 truncate text-[12px] font-medium text-fg">{data.label}</span>
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="mono text-[9.5px] uppercase tracking-wide text-fgf">{data.kind}</span>
        <span className={`rounded px-1.5 py-px text-[9.5px] font-medium ${style.badge}`}>{data.state.replace(/_/g, ' ')}</span>
      </div>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-line2" />
    </div>
  )
}

const nodeTypes = { orch: OrchNodeComponent }

export function DagCanvas({
  nodes,
  edges,
  onSelect,
  selectedId,
  fitView,
  height = '100%',
}: {
  nodes: FlowNode[]
  edges: WorkflowEdge[]
  onSelect?: (node: FlowNode) => void
  selectedId?: string | null
  fitView?: boolean
  height?: string | number
}) {
  const rfNodes = useMemo<OrchNode[]>(
    () =>
      nodes.map((n) => ({
        id: n.id,
        type: 'orch',
        position: { x: n.x, y: n.y },
        selected: n.id === selectedId,
        data: {
          label: n.label,
          kind: n.kind,
          state: n.state,
          detail: n.detail,
        },
      })),
    [nodes, selectedId],
  )

  const rfEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) => {
        const failed = nodes.some((n) => n.id === e.sourceNodeId && n.state === 'failed')
        const active = nodes.some((n) => n.id === e.sourceNodeId && (n.state === 'running' || n.state === 'succeeded'))
        return {
          id: e.id,
          source: e.sourceNodeId,
          target: e.targetNodeId,
          label: e.label || undefined,
          animated: active && !failed,
          style: {
            stroke: failed ? 'var(--color-danger)' : active ? 'var(--color-accent)' : 'var(--color-line2)',
            strokeWidth: 1.6,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color: failed ? 'var(--color-danger)' : 'var(--color-line2)' },
        }
      }),
    [edges, nodes],
  )

  if (nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[12.5px] text-fgf">
        No workflow nodes yet — the planner emits them once the plan is approved.
      </div>
    )
  }

  return (
    <div style={{ height, minHeight: 260 }} className="dag-canvas">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        fitView={fitView ?? true}
        fitViewOptions={{ padding: 0.22, maxZoom: 1.1 }}
        minZoom={0.25}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => {
          const original = nodes.find((n) => n.id === node.id)
          if (original) onSelect?.(original)
        }}

      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="rgba(255,255,255,0.07)" />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable className="!bg-panel2" maskColor="rgba(10,12,16,0.75)" />
      </ReactFlow>
    </div>
  )
}
