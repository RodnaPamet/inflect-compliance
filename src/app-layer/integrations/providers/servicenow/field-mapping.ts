/**
 * Per-connection field mapping for ServiceNow, and the reason it fails closed.
 *
 * ServiceNow instances are heavily customised — tables get renamed columns,
 * u_-prefixed custom fields, and reordered choice lists — so a hardcoded field
 * name is wrong on arrival at most customers. The mapping therefore has to be
 * per-connection config.
 *
 * ═══ THE FAILURE THIS EXISTS TO PREVENT ═══
 *
 * `BaseFieldMapper.toRemotePartial` skips an unmapped field with a bare
 * `continue` (base-mapper.ts:125). That is right for an OPTIONAL field and
 * catastrophic for a required one, and the two are indistinguishable to it
 * because nothing tells it which is which.
 *
 * So a connection whose mapping omits `severity` writes an incident with no
 * severity. From our side the POST returned 201 and the sync is green. From
 * theirs the record is unroutable — it sits outside every priority-based
 * assignment rule, so nobody is paged and nobody knows it exists.
 *
 * That is the exact shape this product's audit trail exists to prevent: a
 * record that looks successful on one side and is useless on the other, with no
 * signal anywhere. A loud refusal before the write is strictly better than a
 * partial record after it, because the partial record cannot be distinguished
 * from a real one afterwards.
 *
 * ═══ VALIDATED BEFORE THE WRITE, NOT DURING IT ═══
 *
 * `assertMappingComplete` runs against the CONFIG, so it can fail at connection
 * setup and at push time before anything is sent. Validating during mapping
 * would produce the error after some fields had already been assembled, which
 * invites a caller to send the partial payload it is already holding.
 *
 * @module integrations/providers/servicenow/field-mapping
 */
import type { FieldMappings } from '../../base-mapper';

/**
 * Local fields that MUST have a target, per outbound record type.
 *
 * "Required" here means: without it the remote record is unusable to the
 * customer, not merely incomplete. Each entry is a claim about ServiceNow's
 * routing behaviour, so each carries its reason.
 */
export const REQUIRED_OUTBOUND_FIELDS: Readonly<Record<string, readonly string[]>> = {
    // An incident with no short_description shows as a blank row in every
    // queue view; with no urgency it falls outside priority-based assignment
    // rules, so nobody is paged.
    incident: ['title', 'description', 'urgency'],
    // A change_request with no type cannot enter an approval workflow at all —
    // the workflow is selected BY type — so it lands in a state no approver
    // ever sees.
    change_request: ['title', 'description', 'changeType'],
};

export class ServiceNowMappingError extends Error {
    readonly missingFields: string[];
    readonly recordType: string;
    constructor(recordType: string, missingFields: string[]) {
        super(
            `ServiceNow ${recordType} mapping is missing a target for: ${missingFields.join(', ')}. ` +
                `Writing without these produces a record the instance cannot route, so no record was created.`,
        );
        this.name = 'ServiceNowMappingError';
        this.recordType = recordType;
        this.missingFields = missingFields;
    }
}

/**
 * Refuse a mapping that would produce an unroutable record.
 *
 * Reports EVERY missing field rather than the first. An admin fixing a mapping
 * one error at a time through a connection form is being made to rediscover the
 * requirement list by trial, and each cycle is a round trip through a test
 * connection.
 */
export function assertMappingComplete(recordType: string, mappings: FieldMappings): void {
    const required = REQUIRED_OUTBOUND_FIELDS[recordType];
    if (!required) {
        // An unknown record type has no requirement list, so nothing here can
        // vouch for it. Refusing is the fail-closed reading: the alternative is
        // that a typo'd record type silently skips validation entirely, which
        // turns this whole module off for the connection that typo'd it.
        throw new ServiceNowMappingError(recordType, [`(unknown record type "${recordType}")`]);
    }
    const missing = required.filter((f) => {
        const target = mappings[f];
        // A mapping present but blank is the same failure as an absent one, and
        // is likelier — an admin who cleared a form field rather than one who
        // never filled it in.
        return typeof target !== 'string' || target.trim() === '';
    });
    if (missing.length > 0) throw new ServiceNowMappingError(recordType, missing);
}

/**
 * Merge a connection's custom mapping over the defaults.
 *
 * Kept separate from `BaseFieldMapper`'s own `customMappings` merge so the
 * result can be VALIDATED before a mapper is constructed with it. Building the
 * mapper first and checking afterwards leaves a window where a caller holds a
 * usable-looking mapper that will silently drop a required field.
 */
export function resolveOutboundMappings(
    defaults: FieldMappings,
    custom: unknown,
): FieldMappings {
    if (!custom || typeof custom !== 'object' || Array.isArray(custom)) return { ...defaults };
    const out: FieldMappings = { ...defaults };
    for (const [local, remote] of Object.entries(custom as Record<string, unknown>)) {
        // Only string targets. A number or object would be coerced to
        // "[object Object]" as a ServiceNow column name, which fails at the API
        // rather than here — a worse place to learn about it.
        if (typeof remote === 'string') out[local] = remote;
    }
    return out;
}
