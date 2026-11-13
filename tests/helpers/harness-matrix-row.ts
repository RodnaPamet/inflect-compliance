/**
 * A harness-tab matrix row for rendered tests, built THROUGH the shared table
 * model (`buildHarnessMatrix`), never by hand: a fixture that wrote a model
 * row's members itself could describe a row the model would never produce,
 * and the component under test would then be checked against a fiction.
 *
 * Defaults describe a registered agent found through `entra-sp`, every source
 * read in full, write reach (bar H3), evidenced through H2 — so below its bar.
 */
import {
    buildHarnessMatrix,
    type HarnessMatrixAgentInput,
    type HarnessMatrixSource,
} from '@rodnapamet/scanent-contract/harness-matrix-model';

import {
    HARNESS_CRITERIA,
    HARNESS_LEVELS,
    rungOf,
    type CriterionVerdict,
    type HarnessCriterionId,
    type HarnessLevel,
} from '@/lib/agentic/harness-ladder';
import type { MatrixRow } from '@/lib/agentic/harness-read-model';

/** Evidenced verdicts for every criterion up to and including `level`. */
export function verdictsThrough(level: HarnessLevel): CriterionVerdict[] {
    return HARNESS_LEVELS.slice(1, rungOf(level) + 1).flatMap((l) =>
        (HARNESS_CRITERIA[l] as readonly HarnessCriterionId[]).map((criterion) => ({
            criterion,
            met: true,
            evidence: `https://evidence.example/${criterion}`,
        })),
    );
}

export const ALL_SOURCES_COMPLETE: readonly HarnessMatrixSource[] = [
    { kind: 'entra-sp', status: 'COMPLETE', reason: null },
    { kind: 'mcp', status: 'COMPLETE', reason: null },
];

export interface MatrixRowFixture extends Partial<Omit<MatrixRow, 'matrix'>> {
    readonly discoveredId?: string;
    readonly discoveredVia?: readonly string[];
    readonly reach?: HarnessMatrixAgentInput['reach'];
    /** The observed verdicts; `null` is stored verdicts that did not re-read. Default: through H2. */
    readonly verdicts?: readonly CriterionVerdict[] | null;
    /** The scan's sources; `null` is stored sources that did not re-read. */
    readonly sources?: readonly HarnessMatrixSource[] | null;
    /** The class on record. */
    readonly unregisteredIdentity?: boolean;
}

export function matrixRowFixture(over: MatrixRowFixture = {}): MatrixRow {
    const {
        discoveredId = 'entra:sp:one',
        discoveredVia = ['entra-sp'],
        reach = 'WRITE_OR_EXTERNAL',
        verdicts = verdictsThrough('H2'),
        sources = ALL_SOURCES_COMPLETE,
        unregisteredIdentity = false,
        ...rest
    } = over;
    const registered = 'registered' in rest ? rest.registered ?? null : { agentId: 'agt_1', name: 'Reconciler' };
    const model = buildHarnessMatrix({
        sources,
        agents: [
            {
                discoveredId,
                discoveredVia,
                verdicts,
                reach,
                registeredAgentId: registered?.agentId ?? null,
                linkBasis: null,
                unregisteredIdentity,
                modelSigns: [],
                paymentCapabilities: null,
            },
        ],
    });
    return {
        discoveredAgentId: 'da_1',
        models: { state: 'NOT_REPORTED' },
        latestIngestedLevel: null,
        acceptance: null,
        acceptAffordance: 'NONE',
        ...rest,
        registered,
        matrix: model.rows[0],
    };
}
