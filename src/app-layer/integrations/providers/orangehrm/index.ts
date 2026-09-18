/**
 * OrangeHRM — HRIS roster connector.
 *
 * ═══ WHY IT EXISTS, WHICH IS NOT WHY YOU WOULD GUESS ═══
 *
 * This provider is not here because a customer asked for OrangeHRM. It is here
 * because the JML HRIS write-back is blocked on questions this repo cannot
 * answer, and `docs/jml-hris-write-back-design.md` says so under a heading
 * reading "Open questions — unresolved, and deliberately not resolved by
 * assertion":
 *
 *   > 2. Is `r.id` (`hris/index.ts:267`) ever populated today? The field list
 *   >    at `:259` does not request it. […] Check against a real tenant before
 *   >    estimating.
 *
 * There is no real tenant to check. BambooHR and Workday are customer-owned: we
 * can read what a tenant exposes, but we cannot create an employee, blank an
 * `Employee #`, change a status, or observe what the API returns for a field we
 * did not request. Every open question in that document is of that shape.
 *
 * OrangeHRM is self-hostable, so its HR side is controllable. That — a
 * directory we can WRITE to and then read back through our own connector — is
 * the whole of what this module is for (#2548).
 *
 * It is registered, so it appears in the connector list and can hold a
 * connection, because the sync path resolves providers through the registry
 * (`usecases/hris-sync.ts` → `registry.getProvider(conn.provider)`) and an
 * unregistered provider cannot be exercised end to end at all.
 *
 * IT SHIPPED FIRST AS AN EXPLICITLY-LABELLED INTERNAL FIXTURE (#2548), because
 * its field mapping was written from OrangeHRM 5.x's published v2 PIM payload
 * and had never met a live instance. The label came off when that finally
 * happened — and the run did not confirm the mapping, it DISPROVED it, in five
 * separate places (#2587). The list row carries neither the work email nor any
 * date; a supervisor entry carries no email either; `terminationId` names a
 * reason rather than a date; and the two per-employee paths disagree about
 * plurality. `roster.ts` carries the full inventory and how each was
 * established.
 *
 * So what the label change rests on is not "somebody looked and it was fine".
 * It is that the connector now reads the payload a live 5.9 actually returns,
 * field by field, with the mapping checked in both directions — an employee
 * with an email resolves it, one without is dropped, a terminated employee
 * comes back TERMINATED with the right date, and a supervisor resolves to a
 * manager. That is the standard the two customer-owned HRIS providers in this
 * repo have never been held to, because neither can be.
 *
 * The connector still REFUSES a page of rows none of which carry a work email
 * (see `roster.ts`), and that refusal did not become vestigial when the
 * mapping became measured: the measurement is of ONE instance at ONE version.
 * A silently wrong field name reads as an empty roster, and an empty roster
 * reads as everyone having left.
 *
 * ═══ ONE ENABLED HRIS CONNECTION PER TENANT APPLIES TO IT (#2500) ═══
 *
 * `orangehrm` is in `HRIS_PROVIDERS`, so `assertSoleEnabledHrisConnection`
 * refuses an enabled OrangeHRM connection on a tenant that already has an
 * enabled BambooHR or Workday one, and vice versa. That is not an oversight to
 * work around — it is required, and it is REQUIRED IN BOTH DIRECTIONS:
 *
 * The departure reconcile in `usecases/hris-sync` is TENANT-scoped, because
 * `Employee` carries `externalId` and `source` and no `connectionId`. Two
 * enabled HRIS connections therefore do not split a roster between them: each
 * pass stamps its own people and marks everyone with an older stamp TERMINATED
 * — the whole of the other connection's population — and TERMINATED is what
 * makes an employee a candidate for a real directory disable on the 05:00
 * leaver pass.
 *
 * The practical consequence for whoever uses this fixture: A REHEARSAL TENANT
 * CANNOT HAVE BOTH THE FIXTURE AND A REAL HRIS ENABLED AT ONCE. Disable one
 * first. Leaving `orangehrm` out of `HRIS_PROVIDERS` would have dodged the
 * refusal and bought exactly the nightly flip-flop the rule exists to prevent —
 * on the one tenant where somebody is deliberately poking at the roster and
 * would read the churn as their own doing.
 *
 * ═══ COMPOSED FROM THE MODULES BESIDE IT ═══
 *
 *   ./token   the client-credentials exchange (no refresh lifecycle — see it)
 *   ./roster  the paginated, resumable read, and the refusal that makes an
 *             unverified field mapping safe
 *   ./host    the allowlist both of the above pass their host through
 *
 * @module integrations/providers/orangehrm
 */
import type {
    ScheduledCheckProvider,
    ConnectionConfigSchema,
    ConnectionValidationResult,
    CheckResult,
    EvidencePayload,
} from '../../types';
import type { HrisSyncProvider, HrisSyncDeps, ListEmployeesResult } from '../hris';
import { assertOrangeHrmHost } from './host';
import { readOrangeHrmRoster } from './roster';
import { fetchOrangeHrmAccessToken, type OrangeHrmOAuthClient } from './token';

interface OrangeHrmDeps {
    /** Injected in tests so the roster read needs no live instance. */
    readRoster?: typeof readOrangeHrmRoster;
    fetchToken?: typeof fetchOrangeHrmAccessToken;
    fetchImpl?: typeof fetch;
}

/**
 * Pull the three fields out of the merged config+secret object the sync hands
 * over.
 *
 * Returns what is MISSING rather than throwing, so `validateConnection` can
 * name every absent field at once instead of making an operator rediscover them
 * one save at a time.
 */
function readConfig(merged: Record<string, unknown>): {
    client: OrangeHrmOAuthClient;
    missing: string[];
} {
    const str = (k: string) => String(merged[k] ?? '').trim();
    const missing: string[] = [];
    for (const k of ['baseUrl', 'clientId', 'clientSecret']) {
        if (!str(k)) missing.push(k);
    }
    return {
        client: { host: str('baseUrl'), clientId: str('clientId'), clientSecret: str('clientSecret') },
        missing,
    };
}

export class OrangeHrmProvider implements ScheduledCheckProvider, HrisSyncProvider {
    readonly id = 'orangehrm';
    readonly displayName = 'OrangeHRM';
    readonly description =
        'An OrangeHRM directory, read for the HRIS roster. Supports the OAuth2 client-credentials grant ' +
        'against an instance on a host covered by ORANGEHRM_HOSTS.';
    readonly supportedChecks: string[] = [];

    /**
     * TRUE — the Test button makes a real authenticated call.
     *
     * The same argument Workday makes, and it applies harder here. Three fields
     * can each be individually plausible and jointly wrong (an instance host
     * that exists but is somebody's demo, a client id registered against a
     * different instance, a secret that was rotated), and a shape-only check
     * would report every one of those as connected. On a FIXTURE that is worse
     * than on a product integration: the whole value of the thing is that what
     * it reports about the HR side is true, so a Test button that proves only
     * that the form was filled in would undermine its one job.
     */
    readonly liveValidation = true;

    readonly setupGuide =
        'Stand up an OrangeHRM instance on a ' +
        'host covered by ORANGEHRM_HOSTS, register an API client for the OAuth2 client-credentials grant, ' +
        'and provide the instance URL with the client id and secret. Test connection performs a real token ' +
        'exchange against the instance.';

    readonly configSchema: ConnectionConfigSchema = {
        configFields: [
            {
                key: 'baseUrl',
                label: 'OrangeHRM instance URL',
                type: 'string',
                required: true,
                placeholder: 'acme.orangehrmlive.com',
            },
            { key: 'clientId', label: 'API client id', type: 'string', required: true },
        ],
        secretFields: [
            // A SECRET FIELD, not a config field. `configJson` is stored as
            // plaintext JSON and rendered back into a visible input; secretFields
            // go through the encrypted-secret path. Putting it in the wrong half
            // is a one-word mistake that persists a live OAuth2 client secret in
            // the clear.
            {
                key: 'clientSecret',
                label: 'API client secret',
                type: 'string',
                required: true,
                description: 'The secret from the OrangeHRM API client.',
            },
        ],
    };

    private readonly deps: OrangeHrmDeps;
    constructor(deps: OrangeHrmDeps = {}) {
        this.deps = deps;
    }

    /**
     * Shape check, then a REAL token exchange against the instance.
     *
     * The host allowlist runs first and on its own, because a bad host is the
     * one error worth reporting without making the request: everything after it
     * would ship the client secret to whatever was typed.
     */
    async validateConnection(
        config: Record<string, unknown>,
        secrets: Record<string, unknown>,
    ): Promise<ConnectionValidationResult> {
        const { client, missing } = readConfig({ ...config, ...secrets });
        if (missing.length) {
            return { valid: false, error: `Missing required OrangeHRM settings: ${missing.join(', ')}.` };
        }
        try {
            assertOrangeHrmHost(client.host);
        } catch (e) {
            return { valid: false, error: e instanceof Error ? e.message : 'Invalid OrangeHRM instance URL.' };
        }
        try {
            const fetchToken = this.deps.fetchToken ?? fetchOrangeHrmAccessToken;
            await fetchToken(client, { fetchImpl: this.deps.fetchImpl });
            return { valid: true };
        } catch (e) {
            return {
                valid: false,
                error: `OrangeHRM rejected the credentials: ${e instanceof Error ? e.message : String(e)}`,
            };
        }
    }

    async listEmployees(
        config: Record<string, unknown>,
        resumeFrom?: string | null,
        deps: HrisSyncDeps = {},
    ): Promise<ListEmployeesResult> {
        const { client, missing } = readConfig(config);
        // Before any request, so an incomplete connection costs nothing and
        // reports the reason rather than an HTTP status from a URL built out of
        // empty strings.
        if (missing.length) throw new Error(`OrangeHRM connection is incomplete: ${missing.join(', ')}`);

        const fetchToken = this.deps.fetchToken ?? fetchOrangeHrmAccessToken;
        const accessToken = await fetchToken(client, { fetchImpl: this.deps.fetchImpl });

        const read = this.deps.readRoster ?? readOrangeHrmRoster;
        // The deadline is FORWARDED, not recomputed here. It measures the RUN's
        // read phase, which started before the token exchange above — starting
        // a fresh budget at this line would let a slow token exchange push the
        // read past the lock lease it is meant to fit inside (#2508).
        return read({ host: client.host }, accessToken, resumeFrom, {
            fetchImpl: this.deps.fetchImpl,
            readDeadlineAt: deps.readDeadlineAt,
        });
    }

    /**
     * OrangeHRM runs no scheduled checks — the personnel checks that consume
     * this roster belong to the `personnel` provider.
     *
     * ERROR, not NOT_APPLICABLE, and not a throw. `supportedChecks` is empty so
     * the registry never routes here, which is exactly the argument for making
     * the unreachable path fail closed: the only way it runs is a future caller
     * that bypassed the routing, and a provider that answers PASSED to a check
     * it never performed manufactures a green signal for a control nobody
     * evaluated. NOT_APPLICABLE would be milder and still wrong — it reads as
     * "assessed, and it does not apply".
     */
    async runCheck(): Promise<CheckResult> {
        return {
            status: 'ERROR',
            summary: 'OrangeHRM runs no scheduled checks — personnel checks route to the personnel provider.',
            details: {},
            errorMessage: 'no checks',
        };
    }

    mapResultToEvidence(): EvidencePayload | null {
        return null;
    }
}
