/**
 * ServiceNow change_request ↔ local change-evidence mapping (S1).
 *
 * Extends `BaseFieldMapper`, so the declarative `fieldMappings` registry, the
 * dot-notation remote paths, and the per-tenant `customMappings` override all
 * come for free — the tenant-configurable mapping in S6 is that override, not
 * a second mechanism.
 *
 * TWO SHAPES THE TABLE API RETURNS. With `sysparm_display_value=all` every
 * field arrives as `{ value, display_value }` rather than a bare string, and a
 * reference field (`assigned_to`, `cmdb_ci`) arrives that way even without it —
 * `value` is a sys_id, `display_value` is the human name. A mapper that reads
 * the field directly gets `[object Object]` in an evidence record, which is
 * both useless and completely silent. `snValue` is applied on the way in.
 *
 * @module integrations/providers/servicenow/mapper
 */
import { BaseFieldMapper, type FieldMappings } from '../../base-mapper';
import { snValue, type ServiceNowRow } from './client';

/**
 * The five states a change_request approval can be in.
 *
 * Mapped onto three local outcomes because that is what a control cares
 * about: it was approved, it was refused, or it has not been decided.
 * `not_requested` collapses into PENDING deliberately — see below.
 */
export type ChangeApproval = 'APPROVED' | 'REJECTED' | 'PENDING';

export function mapApproval(raw: string): ChangeApproval {
    const s = raw.trim().toLowerCase();
    if (s === 'approved') return 'APPROVED';
    if (s === 'rejected') return 'REJECTED';
    // requested / not_requested / not requested / '' → PENDING.
    //
    // `not_requested` is the interesting one: it means nobody ever asked for
    // approval, which is a WEAKER position than "asked and awaiting an answer",
    // not a stronger one. Anything that treated it as a pass — or dropped it as
    // unmapped — would make an unapproved emergency change indistinguishable
    // from an approved one, which is exactly the control this evidence feeds.
    return 'PENDING';
}

/**
 * Whether the change actually landed in production.
 *
 * ServiceNow's `state` is an integer whose meaning is INSTANCE-SPECIFIC —
 * customers reorder and rename states routinely. So this reads the
 * `display_value` text, and anything it does not recognise is reported as
 * not-closed rather than guessed. An unrecognised state that defaulted to
 * "closed complete" would silently manufacture the evidence.
 */
export function mapChangeState(raw: string): 'CLOSED_COMPLETE' | 'CLOSED_INCOMPLETE' | 'OPEN' {
    const s = raw.trim().toLowerCase();
    if (s.includes('closed complete') || s === 'closed_complete' || s === 'review') return 'CLOSED_COMPLETE';
    if (s.includes('closed') || s.includes('cancel')) return 'CLOSED_INCOMPLETE';
    return 'OPEN';
}

export class ServiceNowChangeMapper extends BaseFieldMapper {
    protected readonly fieldMappings: FieldMappings = {
        externalId: 'sys_id',
        externalKey: 'number',
        title: 'short_description',
        description: 'description',
        approval: 'approval',
        state: 'state',
        risk: 'risk',
        changeType: 'type',
        requestedBy: 'requested_by',
        assignedTo: 'assigned_to',
        assignmentGroup: 'assignment_group',
        openedAt: 'opened_at',
        closedAt: 'closed_at',
        plannedStart: 'start_date',
        plannedEnd: 'end_date',
    };

    protected transformToRemote(_field: string, value: unknown): unknown {
        return value;
    }

    protected transformToLocal(field: string, value: unknown): unknown {
        // EVERY field goes through snValue first. With display_value=all the
        // whole row is {value, display_value} objects, so a mapper that only
        // unwrapped the reference fields would still stringify the rest.
        const raw = snValue(value as ServiceNowRow[string]);
        switch (field) {
            case 'approval':
                return mapApproval(raw);
            case 'state':
                return mapChangeState(raw);
            case 'openedAt':
            case 'closedAt':
            case 'plannedStart':
            case 'plannedEnd':
                return parseServiceNowDate(raw);
            default:
                return raw;
        }
    }
}

/**
 * ServiceNow emits `YYYY-MM-DD HH:MM:SS` with no zone, and the value is UTC.
 *
 * `new Date('2026-01-01 12:00:00')` parses in LOCAL time, so on any server not
 * running UTC every change-request timestamp lands hours out — enough to move a
 * change across a day boundary and put it outside the very window the evidence
 * query selected on. Returns null for an unparseable value rather than an
 * Invalid Date, which serialises to null anyway but compares as neither before
 * nor after anything.
 */
export function parseServiceNowDate(raw: string): Date | null {
    if (!raw.trim()) return null;
    const d = new Date(`${raw.trim().replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
}
