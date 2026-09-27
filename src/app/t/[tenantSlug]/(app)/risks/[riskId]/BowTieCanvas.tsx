'use client';

/* RQ-7 (canvas) — interactive bow-tie diagram via xyflow. Read-only
   projection (draggable + zoomable for inspection; no node/edge editing).
   Consumes the `graph` (nodes + edges) from toXyFlowGraph. */
import {
    Background,
    BackgroundVariant,
    Controls,
    ReactFlow,
    ReactFlowProvider,
    type Edge,
    type Node,
    type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMemo } from 'react';
import { BowTieNode, BOWTIE_NODE_TYPES } from './BowTieNode';

// Stable module-level nodeTypes — every bow-tie node kind renders through the
// one styled component (xyflow requires a stable reference).
const NODE_TYPES: NodeTypes = {
    [BOWTIE_NODE_TYPES.bowTieThreat]: BowTieNode,
    [BOWTIE_NODE_TYPES.bowTieEvent]: BowTieNode,
    [BOWTIE_NODE_TYPES.bowTieConsequence]: BowTieNode,
    [BOWTIE_NODE_TYPES.bowTiePreventiveBarrier]: BowTieNode,
    [BOWTIE_NODE_TYPES.bowTieMitigatingBarrier]: BowTieNode,
};

export interface BowTieGraph { nodes: Node[]; edges: Edge[] }

export function BowTieCanvas({ graph }: { graph: BowTieGraph }) {
    // Edges read better as smoothstep through the barrier columns.
    const edges = useMemo(() => graph.edges.map((e) => ({ ...e, type: 'smoothstep' as const, animated: false })), [graph.edges]);

    // ═══ ATTRIBUTION SHOWN ON PURPOSE ═══
    //
    // `proOptions={{ hideAttribution: true }}` was set on the <ReactFlow> below.
    // React Flow is MIT and the option works without a subscription, but its terms
    // permit removing the attribution only with one:
    //   "Only remove this attribution, if you are subscribed to React Flow Pro."
    //
    // It was set in FOUR components and nobody could confirm the product holds a
    // subscription. Showing the badge costs pixels; hiding it unlicensed is an
    // unlicensed-use finding in a compliance product — so this fails in the safe
    // direction until procurement says otherwise. Re-adding is one line per site
    // the day it is confirmed.
    return (
        <div className="h-[480px] w-full rounded-md border border-border-default bg-bg-default" data-testid="risk-bowtie-canvas">
            <ReactFlowProvider>
                <ReactFlow
                    nodes={graph.nodes}
                    edges={edges}
                    nodeTypes={NODE_TYPES}
                    fitView
                    nodesConnectable={false}
                    edgesFocusable={false}
                    elementsSelectable={false}
                >
                    <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
                    <Controls showInteractive={false} />
                </ReactFlow>
            </ReactFlowProvider>
        </div>
    );
}
