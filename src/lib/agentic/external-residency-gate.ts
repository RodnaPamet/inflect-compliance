/**
 * ROUTING AN ERP'S ROWS TO AN EXTERNAL MODEL IS A TRANSFER (M5, #3872).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS DECIDES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A run that reads third-party business or personal data out of a system of
 * record and hands it to a model provider outside the deployment is a data
 * TRANSFER, not an implementation detail. The SAP roadmap's Phase 0 item 6
 * settled it in those terms — "the facts Joule hands it are still customer
 * names, SAP usernames and order values. Routing them to `inflect-external` is
 * a transfer decision; `inflect-local` exists for exactly this."
 *
 * So this module answers one question, purely: given where this run's model
 * calls are going, which connections it was offered tools on, and whether the
 * tenant has acknowledged the transfer, must the run be refused?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE THINGS THAT ARE DELIBERATE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **`=== true`, never truthiness.** `reachesBusinessSystem` has three states
 * (#3864): `true` and `false` are reviewed claims, NULL is nobody having said.
 * Acting on NULL would refuse every run on every connection nobody has
 * reviewed, which is most of them, and the resulting refusal would be about
 * our own bookkeeping rather than about a transfer. Fail-closed is the right
 * default for *authority*; it is the wrong default for a *claim about the
 * world*, because a claim nobody has made is not evidence.
 *
 * **It reads the OFFERED set, not the granted one.** A tool withheld from the
 * offer transfers nothing: the model never sees it and cannot call it. So a
 * write tool already withheld by #3872's read-only narrowing does not make a
 * run refuse here, and a run whose business-system tools were all withheld
 * proceeds — correctly, because nothing of theirs can leave.
 *
 * **It is PURE, and it refuses rather than degrades.** No Prisma, no tenant
 * read, no residency resolution of its own — the caller supplies all three
 * terms. And when it refuses, the whole run refuses: silently dropping the
 * business-system tools and continuing would be a run that answers a question
 * about an ERP without having read it, which is worse than no answer. "Zero is
 * never complete" applies to the inputs of an answer as much as to a
 * population.
 */
import { FLUE_PROVIDER_IDS } from './flue/model-selection';

/** One external tool as it was OFFERED, reduced to what this gate reads. */
export interface OfferedExternalTool {
    readonly name: string;
    readonly connectionId: string;
    readonly connectionName: string;
    readonly reachesBusinessSystem: boolean | null;
}

/**
 * The tenant's acknowledgement, as stored. Both columns or neither — a CHECK
 * makes the half-set state unrepresentable, and this type does not pretend
 * otherwise by accepting one without the other.
 */
export interface ExternalAiAcknowledgement {
    readonly at: Date | null;
    readonly byUserId: string | null;
}

/**
 * The two columns this gate reads, as a select clause.
 *
 * SEPARATE from `RESIDENCY_SELECT` on purpose. That constant is shared by six
 * sites and its own docstring warns that "a fourth column, or a rename, is a
 * silent partial update" — five of those six have no interest in this
 * acknowledgement, and widening a shared select so one caller can reach two
 * extra columns is how that warning comes true. The driver spreads both into
 * one query, so there is still only one read.
 */
export const EXTERNAL_AI_ACK_SELECT = {
    externalAiBusinessDataAckAt: true,
    externalAiBusinessDataAckByUserId: true,
} as const;

/**
 * Map a settings row to the acknowledgement. An ABSENT row is unacknowledged,
 * which refuses — the same direction a NULL column takes, and the right one: a
 * workspace with no settings row has accepted nothing.
 */
export function acknowledgementFrom(
    row:
        | {
              readonly externalAiBusinessDataAckAt?: Date | null;
              readonly externalAiBusinessDataAckByUserId?: string | null;
          }
        | null
        | undefined,
): ExternalAiAcknowledgement {
    return {
        at: row?.externalAiBusinessDataAckAt ?? null,
        byUserId: row?.externalAiBusinessDataAckByUserId ?? null,
    };
}

export interface ResidencyGateInput {
    /** The provider id this run's model calls will go to. */
    readonly providerId: string;
    readonly offered: readonly OfferedExternalTool[];
    readonly acknowledgement: ExternalAiAcknowledgement;
}

export interface ResidencyRefusal {
    readonly reason: 'EXTERNAL_AI_BUSINESS_DATA_UNACKNOWLEDGED';
    /** The connections that caused it, named so an admin knows what to act on. */
    readonly connectionNames: readonly string[];
    /** The run's `errorMessage`, written for the person who has to fix it. */
    readonly message: string;
}

/** Is the acknowledgement present AND attributable? */
export function isAcknowledged(ack: ExternalAiAcknowledgement): boolean {
    // Both terms. An acknowledgement nobody can attribute is not one, and the
    // database CHECK already refuses the half-set row — this is the same rule
    // at the read boundary, so a row written before that CHECK existed, or by a
    // future raw UPDATE, cannot clear the gate anonymously.
    return ack.at !== null && ack.byUserId !== null;
}

/**
 * The connections among the offered tools that carry business data, by name,
 * de-duplicated and sorted so a refusal message is stable.
 */
export function businessSystemConnections(
    offered: readonly OfferedExternalTool[],
): readonly string[] {
    const names = new Set<string>();
    for (const tool of offered) {
        // `=== true` — see the module docstring. NULL is not a claim.
        if (tool.reachesBusinessSystem === true) names.add(tool.connectionName);
    }
    return [...names].sort();
}

/**
 * Must this run be refused for routing business data outside the deployment?
 *
 * `null` means proceed. Every other answer names the connections, because an
 * admin cannot act on "a connection".
 */
export function externalResidencyRefusal(input: ResidencyGateInput): ResidencyRefusal | null {
    // A run whose model calls stay inside the deployment transfers nothing, so
    // the acknowledgement is irrelevant to it. Compared against the provider id
    // rather than a residency enum because the id IS the routing decision —
    // `model-selection.ts` owns that mapping and this module must not form a
    // second opinion about which residency means "outside".
    if (input.providerId !== FLUE_PROVIDER_IDS.external) return null;

    const connectionNames = businessSystemConnections(input.offered);
    if (connectionNames.length === 0) return null;

    if (isAcknowledged(input.acknowledgement)) return null;

    return {
        reason: 'EXTERNAL_AI_BUSINESS_DATA_UNACKNOWLEDGED',
        connectionNames,
        message:
            'flue_external_ai_business_data_unacknowledged: this run would read '
            + `${connectionNames.length === 1 ? 'a connection' : 'connections'} marked as `
            + `carrying third-party business or personal data (${connectionNames.join(', ')}) `
            + 'and send what it reads to an external model provider. Nobody has '
            + 'acknowledged that transfer for this workspace. Either record the '
            + 'acknowledgement on Admin → Security settings, or set AI residency to '
            + 'LOCAL_ONLY so inference stays on your own gateway.',
    };
}
