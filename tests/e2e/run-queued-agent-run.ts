/**
 * EXECUTE ONE QUEUED AGENT RUN with the worker's own job body, for an
 * end-to-end spec (Step 5d of docs/claude-managed-agents-design.md).
 *
 *     node --import tsx tests/e2e/run-queued-agent-run.ts <tenantId> <runId>
 *
 * The E2E harness runs no BullMQ worker (owner decision of 2026-10-29 on
 * #4150): every enqueued job of every spec would run beside the suite. A
 * reasoning-engine run is therefore queued by the web tier and left there. A
 * spec that must see one COMPLETE runs exactly that run here, in a process of
 * its own, through `runAgentRunExecute`: the adapter the worker calls for an
 * `agent-run-execute` job, which rebuilds the principal, re-resolves the engine
 * through the real gate and executes the PINNED definition. Nothing about the
 * run is chosen here but its id.
 *
 * The spec sets NEXT_TEST_MODE and AUTH_TEST_MODE on this process, as the
 * Playwright webServer sets them on `next start`, so the engine's client dials
 * the loopback faux (`e2e-faux.ts`) and nothing else. It prints the outcome as
 * one JSON line and exits, because the Prisma and Redis clients it opened would
 * otherwise hold the process open. The outcome line starts `RUN_OUTCOME `,
 * because the run's own log lines share stdout.
 */
import 'dotenv/config';

import { runAgentRunExecute } from '../../src/app-layer/jobs/agent-run-execute';

/** The outcome line's prefix: the process's own log lines share its stdout. */
const OUTCOME_PREFIX = 'RUN_OUTCOME ';

async function main(): Promise<void> {
    const [tenantId, runId] = process.argv.slice(2);
    if (!tenantId || !runId) {
        process.stderr.write('usage: run-queued-agent-run.ts <tenantId> <runId>\n');
        process.exit(2);
    }
    const outcome = await runAgentRunExecute({ tenantId, runId });
    process.stdout.write(`${OUTCOME_PREFIX}${JSON.stringify(outcome)}\n`);
    process.exit(0);
}

main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
});
