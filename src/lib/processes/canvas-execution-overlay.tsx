'use client';

/**
 * Live execution overlay (Visual Rule Editor VR-6).
 *
 * Polls the live-executions endpoint (Roadmap-A Epic 10) every 3s and exposes
 * a `ruleId → ExecutionOverlayState` map the canvas paints onto automation
 * nodes/edges in Run Mode.
 *
 * Distribution is via context, NOT a per-node hook: the canvas computes the
 * map once (one SWR subscription) and provides it; each `ProcessTypedNode`
 * reads its own ruleId through `useNodeOverlayStatus`. This keeps the node
 * renderer free of tenant-context / network dependencies (so it still renders
 * in isolation in tests + SSR) — the overlay is simply empty without a provider.
 */
import {
    createContext,
    useContext,
    type ReactNode,
} from 'react';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';

export type OverlayStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';

export interface ExecutionOverlayState {
    status: OverlayStatus;
    startedAt: string;
    /** simultaneous executions of this rule (running) */
    count: number;
}

interface LiveExecutionItem {
    ruleId: string;
    status: string;
    createdAt: string;
}
interface LiveExecutionsResponse {
    running: LiveExecutionItem[];
    recent: LiveExecutionItem[];
}

/**
 * Pure reducer (unit-tested): RUNNING wins over a terminal state for the same
 * rule; running rows accumulate a `count`. Recent terminal rows fill in
 * status for rules not currently running so a just-finished node still flashes.
 */
export function buildOverlayMap(
    resp: LiveExecutionsResponse | undefined,
): Map<string, ExecutionOverlayState> {
    const map = new Map<string, ExecutionOverlayState>();
    if (!resp) return map;
    for (const r of resp.recent ?? []) {
        if (!map.has(r.ruleId)) {
            map.set(r.ruleId, {
                status: (r.status as OverlayStatus) ?? 'SKIPPED',
                startedAt: r.createdAt,
                count: 0,
            });
        }
    }
    for (const r of resp.running ?? []) {
        const existing = map.get(r.ruleId);
        map.set(r.ruleId, {
            status: 'RUNNING',
            startedAt: r.createdAt,
            count: (existing?.status === 'RUNNING' ? existing.count : 0) + 1,
        });
    }
    return map;
}

/**
 * Visual treatment for an overlay status — the class the node renderer applies
 * to its chassis in Run Mode. Pure, so it's unit-tested without the canvas.
 */
export function overlayClassFor(status: OverlayStatus | undefined): string {
    switch (status) {
        case 'RUNNING':
            return 'ring-2 ring-brand-default animate-pulse';
        case 'SUCCEEDED':
            return 'ring-2 ring-content-success';
        case 'FAILED':
            return 'ring-2 ring-content-error';
        case 'SKIPPED':
            return 'opacity-50';
        default:
            return '';
    }
}

/**
 * WHAT ONE AGENT NODE'S LATEST RUN IS DOING (#3472).
 *
 * A SECOND channel beside the execution overlay above, not a widening of it.
 * An execution is a rule FIRING; a run is the agentic work that firing
 * started, and they settle at different times — a firing can succeed while the
 * run it enqueued is still reasoning. Folding them into one state would make
 * the node's chassis answer one question and its label answer another.
 *
 * The join that makes this possible is `WorkflowRun.parentExecutionId`
 * (#3537); see `listCanvasAgentRuns` for why `(agentId, workflowKey)` is not a
 * substitute.
 */
export interface AgentRunOverlayState {
    runId: string;
    workflowKey: string;
    status: string;
    stepCount: number;
    /** The last RECORDED step — the ledger is append-only, so it is the latest. */
    lastStepSeq: number | null;
    lastStepKind: string | null;
    lastStepTool: string | null;
}

/**
 * The response shape, DERIVED from what the usecase returns rather than
 * restated.
 *
 * Restating it is how the execution overlay above came to read `resp.running`
 * — a field `listLiveExecutions` has never returned — so that branch has never
 * run and its unit test passes by constructing the field itself (#3546). A
 * derived type makes the same mistake a compile error.
 */
type CanvasAgentRunsResponse = Awaited<
    ReturnType<typeof import('@/app-layer/usecases/automation-executions').listCanvasAgentRuns>
>;

/**
 * Pure reducer: one state per ruleId, keeping the FIRST row for each.
 *
 * The usecase already returns one row per rule, so "first" is "only" — the
 * dedupe is here so a future endpoint that returns a history per rule degrades
 * to the latest rather than to the last one in the array.
 */
export function buildAgentRunMap(
    resp: CanvasAgentRunsResponse | undefined,
): Map<string, AgentRunOverlayState> {
    const map = new Map<string, AgentRunOverlayState>();
    for (const n of resp?.nodes ?? []) {
        if (map.has(n.ruleId)) continue;
        map.set(n.ruleId, {
            runId: n.runId,
            workflowKey: n.workflowKey,
            status: n.status,
            stepCount: n.stepCount,
            lastStepSeq: n.lastStepSeq,
            lastStepKind: n.lastStepKind,
            lastStepTool: n.lastStepTool,
        });
    }
    return map;
}

/**
 * Is this run waiting on a PERSON?
 *
 * `AWAITING_APPROVAL` is the only status that means a human has to act, and it
 * is the one the plan asks the canvas to badge. `PAUSED` is deliberately not
 * included: a deploy paused it and it resumes on its own, so badging it would
 * send an operator looking for an approval queue that is empty.
 */
export function awaitsAHuman(state: AgentRunOverlayState | undefined): boolean {
    return state?.status === 'AWAITING_APPROVAL';
}

const AgentRunContext = createContext<Map<string, AgentRunOverlayState>>(new Map());

/** Node-side read — safe without a provider (empty map → no agent overlay). */
export function useNodeAgentRun(ruleId: string | undefined): AgentRunOverlayState | undefined {
    const map = useContext(AgentRunContext);
    return ruleId ? map.get(ruleId) : undefined;
}

const OverlayContext = createContext<Map<string, ExecutionOverlayState>>(new Map());

/**
 * Canvas-level provider — calls the live SWR poll once (only while `enabled`)
 * and distributes the map to every node via context.
 */
export function CanvasOverlayProvider({
    enabled,
    children,
}: {
    enabled: boolean;
    children: ReactNode;
}) {
    const { data } = useTenantSWR<LiveExecutionsResponse>(
        enabled ? CACHE_KEYS.automation.executions.live() : null,
        { refreshInterval: enabled ? 3000 : 0 },
    );
    // THE SECOND CHANNEL (#3472). A separate subscription on the same
    // `enabled` gate, so a canvas that is not in Run Mode polls neither — and
    // one that is pays for two indexed reads rather than one widened response
    // that `MonitorTab` would also have to carry.
    //
    // A SLOWER interval than the executions poll, deliberately. An execution
    // starts and finishes in milliseconds, so 3s is already coarse for it; an
    // agentic run lasts seconds to minutes and its step count moves on that
    // scale. Polling it at 3s would be three reads per visible change.
    const { data: agentRuns } = useTenantSWR<CanvasAgentRunsResponse>(
        enabled ? CACHE_KEYS.automation.executions.canvasAgentRuns() : null,
        { refreshInterval: enabled ? 8000 : 0 },
    );
    return (
        <OverlayContext.Provider value={buildOverlayMap(data)}>
            <AgentRunContext.Provider value={buildAgentRunMap(agentRuns)}>
                {children}
            </AgentRunContext.Provider>
        </OverlayContext.Provider>
    );
}

/** Node-side read — safe without a provider (empty map → no overlay). */
export function useNodeOverlayStatus(ruleId: string | undefined): OverlayStatus | undefined {
    const map = useContext(OverlayContext);
    return ruleId ? map.get(ruleId)?.status : undefined;
}
