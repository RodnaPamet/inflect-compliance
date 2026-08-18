/**
 * ServiceNow — ITSM change management as compliance evidence (S1 + S2).
 *
 * Two registrations, deliberately different things:
 *   - `integrationRegistry` (bootstrap) bundles the CLIENT + MAPPER for CRUD.
 *   - `registry` (here) routes `servicenow.<check>` automation keys to
 *     `runCheck`.
 *
 * The check engine is a pure function in ./checks; this class is the thin
 * layer that reads the rows and hands them over. Splitting them is what lets
 * the population shapes — empty window, all-standard window, one unapproved
 * change — be tested as fixtures rather than as fetch mocks.
 *
 * @module integrations/providers/servicenow
 */
import type {
    ScheduledCheckProvider,
    ConnectionConfigSchema,
    ConnectionValidationResult,
    CheckInput,
    CheckResult,
    EvidencePayload,
} from '../../types';
import { assertAllowedHost, SERVICENOW_HOSTS } from '../../allowed-host';
import { ServiceNowClient, snValue, type ServiceNowConnectionConfig, type ServiceNowRow } from './client';
import { runServiceNowCheck, SERVICENOW_CHECKS, type ChangeRecord } from './checks';

interface ServiceNowDeps {
    /** Injected in tests so no live instance is needed. */
    readChanges?: (config: Record<string, unknown>) => Promise<ChangeRecord[]>;
    fetchImpl?: typeof fetch;
}

function toChangeRecord(row: ServiceNowRow): ChangeRecord {
    // snValue on every field: with display_value=all the whole row is
    // {value, display_value} objects, and a raw read would compare the check's
    // state/type strings against "[object Object]" — never matching, so every
    // change would drop out of the population and the control would report
    // NOT_APPLICABLE forever while looking like it ran.
    return {
        number: snValue(row.number),
        approval: snValue(row.approval),
        state: snValue(row.state),
        type: snValue(row.type),
    };
}

export class ServiceNowProvider implements ScheduledCheckProvider {
    readonly id = 'servicenow';
    readonly displayName = 'ServiceNow';
    readonly description = 'Change-management evidence from ServiceNow — approvals on production changes.';
    readonly supportedChecks: string[] = [...SERVICENOW_CHECKS];

    /** The Test button makes a real authenticated read of the configured table. */
    readonly liveValidation = true;

    readonly setupGuide =
        'Create a dedicated ServiceNow integration user with read access to the change_request table (a scoped read-only role is enough — this connection never writes). Provide the instance host, the table, and how far back each run should look. Test connection performs a real authenticated read of that table, so an integration user without an ACL on it is reported at setup rather than at 05:00.';

    readonly configSchema: ConnectionConfigSchema = {
        configFields: [
            { key: 'instance', label: 'ServiceNow instance', type: 'string', required: true, placeholder: 'acme.service-now.com' },
            { key: 'table', label: 'Table', type: 'string', required: true, placeholder: 'change_request' },
            { key: 'windowDays', label: 'Look-back window (days)', type: 'number', required: false, placeholder: '90', description: 'How far back each run reads. Should be at least as long as the control period.' },
            { key: 'username', label: 'Integration user', type: 'string', required: true },
        ],
        secretFields: [
            // secretFields, NOT configFields. configJson is stored as plaintext
            // JSON and rendered back into a visible input.
            { key: 'password', label: 'Integration user password', type: 'string', required: true, description: 'The password for the dedicated read-only integration user.' },
        ],
    };

    private readonly deps: ServiceNowDeps;
    constructor(deps: ServiceNowDeps = {}) {
        this.deps = deps;
    }

    async validateConnection(
        config: Record<string, unknown>,
        secrets: Record<string, unknown>,
    ): Promise<ConnectionValidationResult> {
        const merged = { ...config, ...secrets };
        const missing = ['instance', 'table', 'username', 'password'].filter((k) => !String(merged[k] ?? '').trim());
        if (missing.length) {
            return { valid: false, error: `Missing required ServiceNow settings: ${missing.join(', ')}.` };
        }
        try {
            // First and alone — everything after this sends the password.
            assertAllowedHost(String(merged.instance), SERVICENOW_HOSTS);
        } catch (e) {
            return { valid: false, error: e instanceof Error ? e.message : 'Invalid ServiceNow instance.' };
        }
        const client = new ServiceNowClient(merged as ServiceNowConnectionConfig, this.deps.fetchImpl);
        const res = await client.testConnection();
        return res.ok ? { valid: true } : { valid: false, error: res.message };
    }

    async runCheck(input: CheckInput): Promise<CheckResult> {
        const started = Date.now();
        let changes: ChangeRecord[];
        try {
            changes = await this.readChanges(input.connectionConfig);
        } catch (e) {
            // ERROR, never PASSED. A collector that could not read is not a
            // control that found nothing wrong — the two must never render the
            // same, which is the whole H2 invariant.
            const msg = e instanceof Error ? e.message : String(e);
            return {
                status: 'ERROR',
                summary: `Could not read change records from ServiceNow: ${msg}`,
                details: {},
                errorMessage: msg,
                durationMs: Date.now() - started,
            };
        }
        return { ...runServiceNowCheck(input.parsed.checkType, changes), durationMs: Date.now() - started };
    }

    private async readChanges(config: Record<string, unknown>): Promise<ChangeRecord[]> {
        if (this.deps.readChanges) return this.deps.readChanges(config);
        const client = new ServiceNowClient(config as ServiceNowConnectionConfig, this.deps.fetchImpl);
        const page = await client.listRemoteObjects();
        if (page.nextCursor) {
            // The read stopped at its cap with more rows available, so the
            // window was NOT fully seen. Throwing turns that into ERROR rather
            // than letting a partial window be scored — a control that says
            // "all 2,000 changes were approved" over the first 2,000 of 5,000
            // is a false pass, and the missing 3,000 are the older ones the
            // DESC ordering pushed to the end.
            throw new Error(
                'ServiceNow returned more change records than one run reads; narrow the look-back window so the whole period is covered.',
            );
        }
        return page.items.map((i) => toChangeRecord(i.data));
    }

    mapResultToEvidence(input: CheckInput, result: CheckResult): EvidencePayload | null {
        // Only a real outcome becomes evidence. ERROR has nothing to attest,
        // and NOT_APPLICABLE would file "we looked and the period was empty" as
        // though it demonstrated the control.
        if (result.status !== 'PASSED' && result.status !== 'FAILED') return null;
        return {
            title: `ServiceNow change approvals — ${input.parsed.checkType}`,
            content: `${result.summary}\n\n${JSON.stringify(result.details, null, 2)}`,
            type: 'REPORT',
            category: 'change-management',
        };
    }
}
