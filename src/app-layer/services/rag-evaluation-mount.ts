/**
 * THE RAG EVALUATION'S OWN MOUNT DECISION — how the Ragas answer stage asks
 * the product its questions WITH `search_knowledge` before a record exists
 * (Ragas Phase 1.2, `docs/ai-architecture/ragas.md`; the gate is vector store
 * Phase 3.5, `services/knowledge-search-mount.ts`).
 *
 * ── THE CHICKEN AND THE EGG ─────────────────────────────────────────────────
 *
 * The gate offers `search_knowledge` only with a passing record, and a record
 * needs answers the product gave WITH the tool. So the evaluation must be able
 * to mount the tool for the run that measures it, and nothing else may.
 *
 * ── WHY THIS IS NOT A BYPASS IN A DEPLOYED APP ──────────────────────────────
 *
 * There is no route, no flag, no setting and no environment variable here. The
 * decision is a value the CALLER supplies, held in an `AsyncLocalStorage`
 * scope for the duration of one call, and read by the gate's one reader
 * (`getKnowledgeSearchMount`) before it consults the committed records:
 *
 *   • ONE opener, `withRagEvaluationMount`, and ONE caller: the answer stage
 *     (`scripts/rag-eval/answer.ts`), a script the nightly runs in-process
 *     against its own loopback database. No file under `src/` may import it;
 *     `tests/guards/rag-evaluation-mount-unreachable.test.ts` walks every
 *     import in `src/` and `scripts/` and fails if one does, if the gate
 *     imports anything from here but the reader, or if any app entry point
 *     (a route, a page, the middleware, the instrumentation hook, the worker
 *     or the scheduler) can reach `scripts/rag-eval/`.
 *   • A production process refuses the scope at BOTH ends: the opener throws
 *     and the reader returns nothing when `NODE_ENV` is `production`, which
 *     the app image, the worker and the scheduler all run under. That is a
 *     second line behind the first, not a switch: no value of it opens the
 *     gate by itself.
 *   • The decision is bound to ONE tenant. `searchKnowledge` refuses it for any
 *     other (`NOT_EVALUATED`), so even inside the scope only the answer tenant
 *     the harness built is searched.
 *
 * What the scope does NOT do: it changes no other gate, guard, permission or
 * budget. Everything else the answer runs through — the assistant's feature
 * gate, rate limit and input guard, the funnel's exposure, scope and policy
 * checks, the guards on every tool result, the egress guard on the answer —
 * runs exactly as it does for a person.
 *
 * @module app-layer/services/rag-evaluation-mount
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { RetrieverRevision } from '@/lib/ai/embeddings';
import { env } from '@/env';

/** The decision the answer stage supplies: mounted, for this revision, for one tenant, for one evaluation. */
export interface RagEvaluationMount {
    readonly state: 'MOUNTED';
    readonly revision: RetrieverRevision;
    readonly evaluation: {
        /** The only tenant the decision admits: the harness's answer tenant. */
        readonly tenantId: string;
        /** The authored set's content hash the run answers, for the logs and the answers file. */
        readonly setHash: string;
    };
}

const scope = new AsyncLocalStorage<RagEvaluationMount>();

function productionProcess(): boolean {
    return env.NODE_ENV === 'production';
}

export class RagEvaluationMountRefused extends Error {
    constructor(reason: string) {
        super(`rag-evaluation mount refused: ${reason}`);
        this.name = 'RagEvaluationMountRefused';
    }
}

/**
 * THE OPENER. Runs `fn` with `search_knowledge` mounted for `mount.revision`
 * and `mount.evaluation.tenantId`, whatever the committed records say.
 *
 * Only the Ragas answer stage calls this (see the header); a production
 * process refuses it.
 */
export function withRagEvaluationMount<T>(mount: RagEvaluationMount, fn: () => Promise<T>): Promise<T> {
    if (productionProcess()) {
        return Promise.reject(new RagEvaluationMountRefused('a production process never mounts search_knowledge without a record'));
    }
    if (mount.state !== 'MOUNTED' || !mount.evaluation?.tenantId || !mount.evaluation.setHash) {
        return Promise.reject(new RagEvaluationMountRefused('the decision names no tenant or set'));
    }
    return scope.run(mount, fn);
}

/**
 * THE READER, and the only export the gate imports: the evaluation's decision
 * when the current call runs inside `withRagEvaluationMount`, otherwise
 * `undefined`. Never anything in a production process.
 */
export function ragEvaluationMountInScope(): RagEvaluationMount | undefined {
    if (productionProcess()) return undefined;
    return scope.getStore();
}
