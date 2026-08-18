/**
 * Workday — HRIS roster sync into the personnel hub.
 *
 * A sync-only provider: it feeds `Employee`, and the personnel checks that read
 * that roster belong to the `personnel` provider. `supportedChecks` is
 * therefore empty and `runCheck` is unreachable through the registry — see the
 * note on it for why it still has to be fail-closed.
 *
 * Composed from the three modules beside it rather than inlining any of them:
 *   ./token   OAuth2 lifecycle (authorize, code exchange, refresh + persist)
 *   ./roster  the paginated, resumable RaaS read
 *   ./host    the allowlist both of the above pass their host through
 *
 * @module integrations/providers/workday
 */
import type {
    ScheduledCheckProvider,
    ConnectionConfigSchema,
    ConnectionValidationResult,
    CheckResult,
    EvidencePayload,
} from '../../types';
import type { HrisSyncProvider, HrisSyncDeps, ListEmployeesResult } from '../hris';
import { assertWorkdayHost } from './host';
import { readWorkdayRoster, type WorkdayRosterConfig } from './roster';
import { resolveWorkdayAccessToken, type WorkdaySecret, type WorkdayOAuthClient } from './token';

interface WorkdayDeps {
    /** Injected in tests so the roster read needs no live tenant. */
    readRoster?: typeof readWorkdayRoster;
    resolveToken?: typeof resolveWorkdayAccessToken;
    fetchImpl?: typeof fetch;
}

/**
 * Pull the four OAuth2 client fields and the three roster fields out of the
 * merged config+secret object the sync hands over.
 *
 * Returns a list of what is MISSING rather than throwing, so `validateConnection`
 * can name every absent field at once instead of making an admin rediscover
 * them one save at a time.
 */
function readConfig(merged: Record<string, unknown>): {
    client: WorkdayOAuthClient;
    roster: WorkdayRosterConfig;
    secret: WorkdaySecret;
    missing: string[];
} {
    const str = (k: string) => String(merged[k] ?? '').trim();
    const missing: string[] = [];
    for (const k of ['host', 'tenant', 'reportPath', 'clientId', 'clientSecret']) {
        if (!str(k)) missing.push(k);
    }
    return {
        client: { host: str('host'), tenant: str('tenant'), clientId: str('clientId'), clientSecret: str('clientSecret') },
        roster: { host: str('host'), tenant: str('tenant'), reportPath: str('reportPath') },
        secret: {
            accessToken: str('accessToken'),
            refreshToken: str('refreshToken'),
            // Absent expiry reads as ALREADY EXPIRED (0), which forces a refresh
            // on the next run. The other default — treating it as valid — sends
            // an unknown-age token at a live endpoint and turns a recoverable
            // refresh into a credential failure.
            expiresAt: Number(merged.expiresAt ?? 0),
        },
        missing,
    };
}

export class WorkdayProvider implements ScheduledCheckProvider, HrisSyncProvider {
    readonly id = 'workday';
    readonly displayName = 'Workday';
    readonly description = 'Sync the worker roster from Workday into the personnel hub.';
    readonly supportedChecks: string[] = [];

    /**
     * TRUE — the Test button makes a real authenticated call.
     *
     * BambooHR is `liveValidation = false` and its validateConnection only
     * checks that fields are non-empty, so its Test button proves the form was
     * filled in. That is defensible for a static API key typed once. It is not
     * defensible here: Workday has five fields that can each be individually
     * plausible and jointly wrong (a host in the right domain but the wrong
     * datacenter, a tenant that exists but is the sandbox, a report path the
     * ISU cannot read), and a shape-only check would report every one of those
     * as connected. The failure would surface at 04:00 the following morning as
     * a sync error, which is the wrong time and the wrong person.
     */
    readonly liveValidation = true;

    readonly setupGuide =
        'In Workday, register an API Client for Integrations with the Staffing scope and a redirect URI, then publish the Inflect roster report as a RaaS custom report. Provide the tenant host, tenant name, report path, and the client id + secret. Test connection performs a real token exchange against your tenant.';

    readonly configSchema: ConnectionConfigSchema = {
        configFields: [
            { key: 'host', label: 'Workday host', type: 'string', required: true, placeholder: 'wd2-impl-services1.workday.com' },
            { key: 'tenant', label: 'Workday tenant', type: 'string', required: true, placeholder: 'acme_preview' },
            { key: 'reportPath', label: 'RaaS report path', type: 'string', required: true, placeholder: '/ccx/service/customreport2/acme/ISU_Inflect/Roster' },
            { key: 'clientId', label: 'API client id', type: 'string', required: true },
        ],
        secretFields: [
            // clientSecret is a SECRET FIELD, not a config field. configJson is
            // stored as plaintext JSON and rendered back into a visible input;
            // secretFields go through the Epic B encrypted-secret path. Putting
            // it in the wrong half is a one-word mistake that persists a live
            // OAuth2 client secret in the clear.
            { key: 'clientSecret', label: 'API client secret', type: 'string', required: true, description: 'The secret from the Workday API Client for Integrations.' },
        ],
    };

    private readonly deps: WorkdayDeps;
    constructor(deps: WorkdayDeps = {}) {
        this.deps = deps;
    }

    /**
     * Shape check, then a REAL token exchange against the customer's tenant.
     *
     * The host allowlist runs first and on its own, because a bad host is the
     * one error worth reporting without making the request: everything after it
     * would ship the client secret to whatever was typed.
     */
    async validateConnection(
        config: Record<string, unknown>,
        secrets: Record<string, unknown>,
    ): Promise<ConnectionValidationResult> {
        const { client, secret, missing } = readConfig({ ...config, ...secrets });
        if (missing.length) {
            return { valid: false, error: `Missing required Workday settings: ${missing.join(', ')}.` };
        }
        try {
            assertWorkdayHost(client.host);
        } catch (e) {
            return { valid: false, error: e instanceof Error ? e.message : 'Invalid Workday host.' };
        }
        if (!secret.refreshToken) {
            // Pre-consent. Field shape is good and there is nothing to probe
            // yet, so say which step is outstanding rather than reporting a
            // failure the admin cannot act on.
            return { valid: false, error: 'Workday is configured but not yet authorised — complete the OAuth consent to connect.' };
        }
        try {
            const resolveToken = this.deps.resolveToken ?? resolveWorkdayAccessToken;
            // expiresAt: 0 forces the refresh path, so this always makes a live
            // call. Probing with a token we already believe is valid would pass
            // on a revoked grant right up until it expired.
            await resolveToken({ ...secret, expiresAt: 0 }, { client }, { fetchImpl: this.deps.fetchImpl });
            return { valid: true };
        } catch (e) {
            return { valid: false, error: `Workday rejected the credentials: ${e instanceof Error ? e.message : String(e)}` };
        }
    }

    async listEmployees(
        config: Record<string, unknown>,
        resumeFrom?: string | null,
        deps: HrisSyncDeps = {},
    ): Promise<ListEmployeesResult> {
        const { client, roster, secret, missing } = readConfig(config);
        if (missing.length) throw new Error(`Workday connection is incomplete: ${missing.join(', ')}`);
        if (!secret.refreshToken) throw new Error('Workday connection is not authorised — complete the OAuth consent');

        const resolveToken = this.deps.resolveToken ?? resolveWorkdayAccessToken;
        const { accessToken } = await resolveToken(secret, { client }, {
            fetchImpl: this.deps.fetchImpl,
            // Persist AT ROTATION, not after the roster read — see HrisSyncDeps.
            // Workday invalidates the predecessor refresh token, so a read that
            // throws after this point must not take the new one with it.
            persist: deps.persistSecret
                ? async (rotated) => {
                      await deps.persistSecret?.({
                          accessToken: rotated.accessToken,
                          refreshToken: rotated.refreshToken,
                          expiresAt: rotated.expiresAt,
                      });
                  }
                : undefined,
        });

        const read = this.deps.readRoster ?? readWorkdayRoster;
        return read(roster, accessToken, resumeFrom, { fetchImpl: this.deps.fetchImpl });
    }

    /**
     * Workday runs no scheduled checks — the personnel checks that consume this
     * roster belong to the `personnel` provider.
     *
     * ERROR, not NOT_APPLICABLE, and not a throw. `supportedChecks` is empty so
     * the registry never routes here, which is exactly the argument for making
     * the unreachable path fail closed rather than leaving it convenient: the
     * only way it runs is a future caller that bypassed the routing, and a
     * provider that answers PASSED to a check it never performed manufactures a
     * green signal for a control nobody evaluated. NOT_APPLICABLE would be
     * milder and still wrong — it reads as "assessed, and it does not apply".
     */
    async runCheck(): Promise<CheckResult> {
        return {
            status: 'ERROR',
            summary: 'Workday runs no scheduled checks — personnel checks route to the personnel provider.',
            details: {},
            errorMessage: 'no checks',
        };
    }

    mapResultToEvidence(): EvidencePayload | null {
        return null;
    }
}
