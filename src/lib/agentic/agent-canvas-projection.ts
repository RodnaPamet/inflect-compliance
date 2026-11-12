/**
 * WHAT THE AGENT CANVAS DRAWS, as data (Phase 2 of
 * `docs/ai-architecture/langflow.md`).
 *
 * The read-only view of one agent on the process canvas is built from layers,
 * and each layer is read from the surface that already owns it:
 *
 *   • the AUTHORITY ENVELOPE — the register row, its tool grants against the
 *     agent's effective ceiling, the pinned policy-card version and the circuit
 *     breaker. Every reader of the agent page sees it.
 *   • the PROFILE — the version the canvas shows, its triggers, model settings,
 *     tools (each OFFERED or narrowed away, with the reason `offerToolSet`
 *     gives), skills (mountable or not) and output kind. Only a reader who may
 *     read a profile on the Behaviour tab sees it, and only where agent
 *     profiles are on.
 *   • the REGISTRY WORKFLOWS the agent is invoked with from a process map, step
 *     by step, in the order the code defines.
 *   • WHERE IT IS USED — the process maps whose `agent` node invokes it.
 *
 * This module holds the shape and nothing else: no Prisma, no React, no
 * renderer. The usecase fills it (`usecases/agent-canvas-projection.ts`) and the
 * graph builder inside the process-canvas module draws it.
 *
 * There is no layout here and no write anywhere: the view stores nothing.
 */
import type { ToolOmissionReason } from '@/lib/agentic/engine-tools/offer-tools';

/** Why a profile tool is not offered to a run of this agent. */
export type AgentCanvasNarrowingReason =
    | ToolOmissionReason
    /**
     * The agent is not ACTIVE, so no run of it is admitted and nothing is
     * offered. Not an `offerToolSet` reason: the probe is not run for an agent
     * whose runs admission refuses, because its answer would describe a run
     * that cannot exist.
     */
    | 'AGENT_NOT_ACTIVE'
    /**
     * The version shown has no run: only the approved version in force runs,
     * and a version submitted for review only as a Test run. Not probed, for
     * the reason above.
     */
    | 'VERSION_NOT_RUNNABLE'
    /**
     * The version can run only as a Test run, which is read-only whatever its
     * output kind: `offerToolSet`'s `READ_ONLY_WORKFLOW`, with its cause named.
     */
    | 'TEST_RUN_READ_ONLY'
    /**
     * An external server's tool the agent is still granted. A run offers it
     * only after a live `tools/list` matches its pin; the view makes no such
     * call (it would exchange a credential and reach a third party on every
     * open), so it says the tool was not checked rather than guess either way.
     */
    | 'EXTERNAL_NOT_PROBED';

/** One profile tool, as a run of this agent started by the viewer would see it. */
export type AgentCanvasProfileToolState =
    | { name: string; offered: true }
    | { name: string; offered: false; reason: AgentCanvasNarrowingReason };

/** One granted tool against the agent's effective autonomy ceiling. */
export interface AgentCanvasGrant {
    name: string;
    capability: 'read' | 'propose';
    requiredAutonomy: number;
    /** False when the ceiling (an unscored tier is DENY) leaves it unreachable. */
    withinCeiling: boolean;
}

/** Why the canvas shows no profile layer. Each is a different next step. */
export type AgentCanvasProfileAbsence =
    /** Agent profiles are off for this workspace: the Behaviour tab does not exist. */
    | 'OFF'
    /** The viewer does not hold `admin.agent_registry`, which reading a profile takes. */
    | 'NOT_PERMITTED'
    /** The agent has no profile version yet. */
    | 'NONE';

export interface AgentCanvasProfileLayer {
    state: 'SHOWN';
    version: number;
    status: string;
    /** True when this version is the approved one in force. */
    inForce: boolean;
    /**
     * The one run this version can have, and so the run its tool states
     * describe: itself (in force), a Test run (submitted for review), or none.
     */
    runAs: 'RUN' | 'TEST_RUN' | null;
    modelTier: string;
    effort: string;
    maxTurns: number;
    outputKind: string;
    /** The run this version can have is offered the read surface only. */
    readOnly: boolean;
    allowedTriggers: string[];
    tools: AgentCanvasProfileToolState[];
    skills: Array<{ origin: 'repository' | 'tenant'; name: string; mountable: boolean }>;
    /** Business content: shown collapsed, and only to readers who hold the profile key. */
    instructions: string;
}

export interface AgentCanvasWorkflow {
    key: string;
    name: string;
    /**
     * Whether the step order is ENFORCED. The static engine walks the steps in
     * order; a reasoning engine reads them as a specification and may deviate,
     * so its order is advisory and is drawn dashed.
     */
    orderEnforced: boolean;
    steps: Array<{ kind: string; label: string; tool: string | null }>;
}

export interface AgentCanvasProjection {
    agent: {
        id: string;
        name: string;
        status: string;
        autonomyLevel: number;
        riskTier: string | null;
        /** min(registered autonomy, tier cap); -1 (DENY) for an unscored agent. */
        effectiveCeiling: number;
    };
    envelope: {
        /** Null when the agent is retired: retirement took every grant away. */
        grants: AgentCanvasGrant[] | null;
        policyCardVersion: number | null;
        breakerState: string | null;
        /** The kill switch in force over this agent, by its scope, or null when none is. */
        killScope: 'PLATFORM' | 'TENANT' | 'AGENT' | null;
    };
    profile: AgentCanvasProfileLayer | { state: AgentCanvasProfileAbsence };
    workflows: AgentCanvasWorkflow[];
    usedIn: Array<{ mapId: string; mapName: string; nodeKey: string }>;
}
