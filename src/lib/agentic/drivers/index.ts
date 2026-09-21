/**
 * Driver selection.
 *
 * Two independent questions, and keeping them apart is the point:
 *
 *   · WHICH driver a workflow ASKS for — `WorkflowDefinition.driver`, defaulted
 *     to `static`, a property of the workflow's own definition;
 *   · WHICH driver it MAY HAVE — `resolveAgentDriver` in `agent-driver.ts`,
 *     the operator's env switch AND the tenant's toggle AND whether this build
 *     implements it, all three of which can only narrow.
 *
 * The answer is the intersection, and it fails closed: a definition asking for
 * `flue` on a deployment that has not enabled it gets `static`, silently and
 * correctly, because a workflow definition is not an authority.
 */
import type { AgentDriver } from '@/lib/agentic/agent-driver';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';

import { runStaticDriver } from './static-driver';
import type { RunDriver } from './types';

export type { RunDriver, RunDriverOutcome } from './types';

/**
 * The implementations this build has.
 *
 * `flue` is deliberately absent rather than mapped to a stub: a stub would make
 * `DRIVERS[driver]` total and hide the gap behind a runtime surprise, where an
 * absent key makes it a compile-time fact that only one driver exists.
 */
const DRIVERS: Partial<Record<AgentDriver, RunDriver>> = {
    static: runStaticDriver,
};

/**
 * Which driver a definition asks for. Absent means `static` — every workflow
 * shipped today omits the field, and that is the answer it should get.
 */
export function requestedDriver(def: WorkflowDefinition): AgentDriver {
    return def.driver ?? 'static';
}

/**
 * Resolve the driver to execute with, given what the definition asks for and
 * what the deployment permits.
 *
 * `permitted` comes from `resolveAgentDriver`, which has already ANDed the env
 * switch, the tenant toggle and `DRIVER_IMPLEMENTED`. This function adds the
 * definition's own request and the final has-an-implementation check, so the
 * result is executable by construction.
 */
export function selectRunDriver(
    def: WorkflowDefinition,
    permitted: AgentDriver,
): { driver: AgentDriver; run: RunDriver } {
    const asked = requestedDriver(def);
    // The definition cannot widen what the deployment permits, so anything
    // other than agreement resolves to static.
    const chosen: AgentDriver = asked === permitted ? asked : 'static';
    const run = DRIVERS[chosen] ?? runStaticDriver;
    // `chosen` is reported rather than inferred at the call site: when the
    // implementation is missing the run is static, and the audit row must say
    // static rather than what was asked for.
    return { driver: run === runStaticDriver ? 'static' : chosen, run };
}
