/**
 * One step of an agent flow, drawn by tldraw (Phase 3 of
 * `docs/ai-architecture/langflow.md`).
 *
 * ═══ GEOMETRY ONLY ═══
 *
 * A step's box can be MOVED, which changes the layout and nothing else. It
 * cannot be resized, its text cannot be edited on the canvas and nothing binds
 * to it: every logic change — label, tool, profile, connections — is made in
 * the inspector, which is the editor's one door to the flow. So a gesture on
 * the canvas has no path to the governed write.
 *
 * The text arrives resolved (a shape util has no translator here, as in the
 * agent view), including the step's diagnostics and, on the approver's diff,
 * what changed.
 */
import { HTMLContainer, Rectangle2d, ShapeUtil, T, type RecordProps, type TLBaseShape } from 'tldraw';

import { Tooltip } from '@/components/ui/tooltip';
import type { FlowNodeKind } from '@/lib/agentic/agent-flow';

import { AGENT_FLOW_NODE_TAXONOMY, NODE_ACCENT_BORDER, NODE_ACCENT_ICON_TONE } from '../node-taxonomy';

export const AGENT_FLOW_NODE_SHAPE_TYPE = 'agent-flow-node' as const;

export type AgentFlowNodeShapeProps = {
    w: number;
    h: number;
    /** The step's key: the shape's link back to the flow. */
    stepKey: string;
    /** A `FlowNodeKind`; an unknown value draws as a read step. */
    kind: string;
    label: string;
    /** Translated second line: the tool or profile, or what is missing. */
    detail: string;
    /** Translated diagnostics; non-empty means the step would not save. */
    problems: string[];
    /** The approver's diff: 'added' | 'changed' | 'removed' | '' (unchanged or no diff). */
    change: string;
};

export type AgentFlowNodeShape = TLBaseShape<typeof AGENT_FLOW_NODE_SHAPE_TYPE, AgentFlowNodeShapeProps>;

export const agentFlowNodeShapeProps: RecordProps<AgentFlowNodeShape> = {
    w: T.nonZeroNumber,
    h: T.nonZeroNumber,
    stepKey: T.string,
    kind: T.string,
    label: T.string,
    detail: T.string,
    problems: T.arrayOf(T.string),
    change: T.string,
};

function metaFor(kind: string) {
    return Object.prototype.hasOwnProperty.call(AGENT_FLOW_NODE_TAXONOMY, kind)
        ? AGENT_FLOW_NODE_TAXONOMY[kind as FlowNodeKind]
        : AGENT_FLOW_NODE_TAXONOMY.read;
}

const CHANGE_BORDER: Record<string, string> = {
    added: 'border-[color:var(--content-success)] border-2',
    changed: 'border-[color:var(--content-warning)] border-2',
    removed: 'border-[color:var(--content-error)] border-dashed opacity-70',
};

export function AgentFlowNodeBody({ shape }: { shape: AgentFlowNodeShape }) {
    const meta = metaFor(shape.props.kind);
    const Icon = meta.icon;
    const broken = shape.props.problems.length > 0;
    const border = broken
        ? 'border-[color:var(--content-error)]'
        : CHANGE_BORDER[shape.props.change] ?? NODE_ACCENT_BORDER[meta.accent];
    return (
        <HTMLContainer
            data-testid={`agent-flow-node-${shape.props.stepKey}`}
            data-kind={shape.props.kind}
            data-change={shape.props.change || 'none'}
            data-broken={broken ? 'true' : 'false'}
            className={`flex flex-col gap-0.5 overflow-hidden rounded-md border bg-bg-default px-3 py-2 text-left ${border}`}
            style={{ width: shape.props.w, height: shape.props.h, pointerEvents: 'all' }}
        >
            <span className="flex min-w-0 items-center gap-1.5">
                <Icon className={`h-3.5 w-3.5 shrink-0 ${NODE_ACCENT_ICON_TONE[meta.accent]}`} aria-hidden="true" />
                <span className="truncate text-sm font-medium text-content-emphasis">{shape.props.label}</span>
            </span>
            <span className="truncate text-xs text-content-muted">{shape.props.detail}</span>
            {broken && (
                <Tooltip content={shape.props.problems.join(' ')}>
                    <span className="truncate text-xs text-[color:var(--content-error)]">{shape.props.problems[0]}</span>
                </Tooltip>
            )}
        </HTMLContainer>
    );
}

export class AgentFlowNodeShapeUtil extends ShapeUtil<AgentFlowNodeShape> {
    static override type = AGENT_FLOW_NODE_SHAPE_TYPE;
    static override props = agentFlowNodeShapeProps;

    override getDefaultProps(): AgentFlowNodeShapeProps {
        return { w: 220, h: 72, stepKey: '', kind: 'read', label: '', detail: '', problems: [], change: '' };
    }

    override getGeometry(shape: AgentFlowNodeShape): Rectangle2d {
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

    override component(shape: AgentFlowNodeShape) {
        return <AgentFlowNodeBody shape={shape} />;
    }

    override indicator(shape: AgentFlowNodeShape) {
        return <rect width={shape.props.w} height={shape.props.h} rx={6} />;
    }
}
