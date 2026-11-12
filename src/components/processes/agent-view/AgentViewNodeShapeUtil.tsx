/**
 * The agent view's node, drawn by tldraw beside `ProcessNodeShapeUtil`.
 *
 * ONE util for the seven agent-view kinds, for the reason the process util is
 * one util for twelve: every per-kind difference is a field on
 * `AGENT_VIEW_NODE_TAXONOMY` (an icon and an accent).
 *
 * ═══ READ-ONLY BY CONSTRUCTION ═══
 *
 * No resize, no edit, no binding. The view stores nothing, so there is no
 * handler here a gesture could reach that would have anywhere to write.
 *
 * ═══ THE TEXT ARRIVES TRANSLATED ═══
 *
 * A shape util has no translator in this codebase (see `chipLabel` in
 * `process-edge-shape.ts`), so the canvas resolves every badge and reason from
 * the `agentCanvas` messages before it creates the shape, and the shape draws
 * strings. The reason is drawn on the node AND carried in a Tooltip, so a
 * narrowing is readable without a hover and named in full with one.
 */
import { HTMLContainer, Rectangle2d, ShapeUtil, T, type RecordProps, type TLBaseShape } from 'tldraw';

import { Tooltip } from '@/components/ui/tooltip';

import {
    AGENT_VIEW_NODE_TAXONOMY,
    NODE_ACCENT_BORDER,
    NODE_ACCENT_ICON_TONE,
} from '../node-taxonomy';
import type { AgentViewNodeKind } from '@/lib/processes/agent-view/agent-canvas-graph';

export const AGENT_VIEW_NODE_SHAPE_TYPE = 'agent-view-node' as const;

export type AgentViewNodeShapeProps = {
    w: number;
    h: number;
    /** An `AgentViewNodeKind`; an unknown value draws as a tool. */
    kind: string;
    label: string;
    /** Translated badge lines. */
    badges: string[];
    /** The translated narrowing or refusal, or null when nothing narrows the node. */
    reason: string | null;
};

export type AgentViewNodeShape = TLBaseShape<typeof AGENT_VIEW_NODE_SHAPE_TYPE, AgentViewNodeShapeProps>;

export const agentViewNodeShapeProps: RecordProps<AgentViewNodeShape> = {
    w: T.nonZeroNumber,
    h: T.nonZeroNumber,
    kind: T.string,
    label: T.string,
    badges: T.arrayOf(T.string),
    reason: T.string.nullable(),
};

function metaFor(kind: string) {
    return Object.prototype.hasOwnProperty.call(AGENT_VIEW_NODE_TAXONOMY, kind)
        ? AGENT_VIEW_NODE_TAXONOMY[kind as AgentViewNodeKind]
        : AGENT_VIEW_NODE_TAXONOMY.tool;
}

export function AgentViewNodeBody({ shape }: { shape: AgentViewNodeShape }) {
    const meta = metaFor(shape.props.kind);
    const Icon = meta.icon;
    const narrowed = shape.props.reason !== null;
    return (
        <HTMLContainer
            data-testid={`agent-view-node-${shape.id}`}
            data-kind={shape.props.kind}
            data-narrowed={narrowed ? 'true' : 'false'}
            className={`flex flex-col gap-0.5 overflow-hidden rounded-md border bg-bg-default px-3 py-2 text-left ${
                narrowed ? 'border-[color:var(--content-warning)] opacity-80' : NODE_ACCENT_BORDER[meta.accent]
            }`}
            style={{ width: shape.props.w, height: shape.props.h, pointerEvents: 'all' }}
        >
            <span className="flex min-w-0 items-center gap-1.5">
                <Icon className={`h-3.5 w-3.5 shrink-0 ${NODE_ACCENT_ICON_TONE[meta.accent]}`} aria-hidden="true" />
                <span className="truncate text-sm font-medium text-content-emphasis">{shape.props.label}</span>
            </span>
            {shape.props.badges.length > 0 && (
                <span className="truncate text-xs text-content-muted">{shape.props.badges.join(' · ')}</span>
            )}
            {shape.props.reason !== null && (
                <Tooltip content={shape.props.reason}>
                    <span
                        data-testid={`agent-view-reason-${shape.id}`}
                        className="truncate text-xs text-[color:var(--content-warning)]"
                    >
                        {shape.props.reason}
                    </span>
                </Tooltip>
            )}
        </HTMLContainer>
    );
}

export class AgentViewNodeShapeUtil extends ShapeUtil<AgentViewNodeShape> {
    static override type = AGENT_VIEW_NODE_SHAPE_TYPE;
    static override props = agentViewNodeShapeProps;

    override getDefaultProps(): AgentViewNodeShapeProps {
        return { w: 220, h: 80, kind: 'tool', label: '', badges: [], reason: null };
    }

    override getGeometry(shape: AgentViewNodeShape): Rectangle2d {
        return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true });
    }

    override canBind(): boolean {
        return false;
    }

    override canResize(): boolean {
        return false;
    }

    override canEdit(): boolean {
        return false;
    }

    override hideRotateHandle(): boolean {
        return true;
    }

    override component(shape: AgentViewNodeShape) {
        return <AgentViewNodeBody shape={shape} />;
    }

    override indicator(shape: AgentViewNodeShape) {
        return <rect width={shape.props.w} height={shape.props.h} rx={6} />;
    }
}
