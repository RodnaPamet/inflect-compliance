/**
 * OrangeHRM — the LIVE write-back preflight. It performs two READS and no
 * write, ever.
 *
 * ═══ WHY THIS PROVIDER AND NOT BAMBOOHR ═══
 *
 * #2607 is standing policy and `docs/jml-hris-write-back-design.md` records it
 * under "New HRIS work is proven against OrangeHRM, not BambooHR": BambooHR and
 * Workday are customer-owned, so this repo cannot create an employee, blank a
 * field, or observe what the API returns for something it did not request.
 * OrangeHRM is self-hostable, so its HR side is controllable, and the rig
 * already exists. That is where evidence comes from while BambooHR remains the
 * first CUSTOMER target.
 *
 * It does NOT make BambooHR's story verified. A different vendor's API is not
 * evidence about this one, and treating it as such would be exactly the
 * assertion-in-place-of-measurement the design exists to refuse.
 *
 * ═══ WHY IT IS TWO READS AND NOT ONE ═══
 *
 * This is the finding, not a convenience. Against a live `orangehrm/orangehrm:5.9`
 * on 2026-09-17 (#2587), a list row's COMPLETE key set is `empNumber`,
 * `empStatus`, `employeeId`, `firstName`, `jobTitle`, `lastName`, `middleName`,
 * `subunit`, `supervisors`, `terminationId`. There is no `workEmail` and no
 * `contactDetails`, at any `model` — proved by A/B rather than inferred, since
 * three of four employees HAVE work emails readable at contact-details and
 * their list rows carry neither key.
 *
 * So on this vendor the write-back HANDLE and the write-back FIELD live in
 * different responses. A preflight that read one roster page and concluded it
 * had seen both would be asserting something at least one vendor does not do —
 * and would report a confident green for an instance whose per-record path it
 * had never touched. Hence: a list read for the address, and a per-record read
 * for the field, reported as two separate observations on the result.
 *
 * ═══ WHAT IT PROVES, AND THE ONE THING IT CANNOT ═══
 *
 * It proves the credential authenticates, that the roster yields an address a
 * write could be sent to, and that the exact field a write would target is
 * readable at the exact path the write would be addressed through. It does not
 * prove the credential may MUTATE, because proving that requires mutating, and
 * Phase 1 does not. `HrisWriteBackPreflightResult.writeProven` is the literal
 * `false` for that reason.
 *
 * The measured facts that a Phase 2 write would rest on are recorded in the
 * design and are NOT exercised here: `PUT /pim/employee/{id}/contact-details`
 * accepts `{"workEmail": …}` and the read-back works. Knowing the verb exists
 * is not permission to send it.
 *
 * ═══ THE PROBE IS ONE ROW, AND WHOSE ROW IT IS DOES NOT MATTER ═══
 *
 * A credential fact is settled once for a connection, so the probe asks for a
 * single row (`limit=1`) under the same pinned ordering the roster read uses —
 * `sortField=employee.empNumber&sortOrder=ASC`, HONOURED on 5.9, which is what
 * makes the same instance answer with the same subject twice.
 *
 * The probe subject's work email being NON-EMPTY is deliberately NOT a refusal.
 * Whether a particular record's field is empty is a CANDIDATE fact belonging to
 * Phase 2's conditional ("empty, or already equal — anything else refuses"),
 * and reading it as a connection fact would refuse whole batches because the
 * lowest-numbered employee in someone's instance happens to have an address.
 * The value is never logged or returned either: what the preflight needs is
 * whether the KEY was in the shape.
 *
 * @module integrations/providers/orangehrm/write-back-preflight
 */
import { IntegrationAuthError, IntegrationTerminalError, resilientFetch } from '../../http-resilience';
import {
    writeBackPreflightResult,
    type HrisWriteBackPreflightResult,
} from '../hris/write-back';
import { assertOrangeHrmHost } from './host';
import { fetchOrangeHrmAccessToken, OrangeHrmTokenError, ORANGEHRM_WEB_ROOT, type OrangeHrmOAuthClient } from './token';

/** The provider id this preflight reports as. */
export const ORANGEHRM_PROVIDER_ID = 'orangehrm';

/**
 * The field a Phase 2 write would put the Entra-minted address into, and
 * therefore the field this preflight has to find readable.
 *
 * Named rather than inlined because the whole preflight is the question "is
 * THIS key present at THAT path", and a preflight that probed one key while the
 * write targeted another would be green for the wrong reason.
 */
export const ORANGEHRM_IDENTITY_FIELD = 'workEmail';

export interface OrangeHrmPreflightDeps {
    fetchImpl?: typeof fetch;
    fetchToken?: typeof fetchOrangeHrmAccessToken;
}

/**
 * What a failed request PROVED, if anything.
 *
 * Decision 4's rule, applied to the two error shapes this provider's transport
 * produces plus the one its token module produces:
 *
 *   · `IntegrationAuthError` — 401/403. The credential was evaluated and
 *     rejected. Proven, and a property of the credential rather than the
 *     record, which is what makes a batch-level refusal sound.
 *   · `IntegrationTerminalError` — 404 and the other terminal statuses. Proven
 *     that the request was evaluated; what it says depends on WHICH path, so
 *     the caller decides.
 *   · `OrangeHrmTokenError` — the token endpoint answered with a status.
 *   · Anything else — a timeout, a reset, an abort, an exhausted retry, a 5xx
 *     rewritten as a rate-limit error, a bug. Nothing is proven.
 *
 * `IntegrationAuthError extends IntegrationTerminalError`, so the auth test
 * comes FIRST. Reversed, a revoked credential would be classified as whatever
 * the terminal branch decided — which is the same subclass trap
 * `roster.ts`'s `fetchWorkEmail` documents at its catch.
 */
function classifyFailure(err: unknown): { status: number | null; provenAuth: boolean } {
    if (err instanceof IntegrationAuthError) return { status: err.status, provenAuth: true };
    if (err instanceof IntegrationTerminalError) return { status: err.status, provenAuth: false };
    if (err instanceof OrangeHrmTokenError) {
        // 400 is how OAuth2 says `invalid_client`; 401/403 is how the API layer
        // in front of it says the same thing. Both are the credential.
        return { status: err.status, provenAuth: [400, 401, 403].includes(err.status) };
    }
    return { status: null, provenAuth: false };
}

/** A status the vendor returned to us, rendered for an operator. */
function statusSuffix(status: number | null): string {
    return status === null ? '' : ` (HTTP ${status})`;
}

/**
 * Run the preflight against a live instance.
 *
 * The host allowlist runs FIRST and on its own, before anything is sent —
 * `validateConnection` makes the same move for the same reason: everything
 * after it would ship a credential to whatever was typed into `configJson`.
 */
export async function preflightOrangeHrmWriteBack(
    client: OrangeHrmOAuthClient,
    deps: OrangeHrmPreflightDeps = {},
): Promise<HrisWriteBackPreflightResult> {
    const provider = ORANGEHRM_PROVIDER_ID;
    const refuse = (
        outcome: HrisWriteBackPreflightResult['outcome'],
        detail: string,
        observed: Partial<
            Pick<HrisWriteBackPreflightResult, 'authenticated' | 'handleObserved' | 'identityFieldReadable'>
        > = {},
    ) => writeBackPreflightResult({ outcome, provider, detail, ...observed });

    let host: string;
    try {
        host = assertOrangeHrmHost(client.host);
    } catch (e) {
        return refuse(
            'REFUSED_CREDENTIAL',
            `The OrangeHRM instance URL on this connection is not usable: ${e instanceof Error ? e.message : String(e)}`,
        );
    }

    const doFetch = deps.fetchImpl ?? resilientFetch;
    const fetchToken = deps.fetchToken ?? fetchOrangeHrmAccessToken;

    // ── 1. Does the credential authenticate at all?
    let accessToken: string;
    try {
        accessToken = await fetchToken(client, { fetchImpl: deps.fetchImpl });
    } catch (e) {
        const { status, provenAuth } = classifyFailure(e);
        return provenAuth
            ? refuse(
                  'REFUSED_CREDENTIAL',
                  `OrangeHRM rejected the stored client credentials${statusSuffix(status)}.`,
              )
            : refuse(
                  'PREFLIGHT_INDETERMINATE',
                  `The OrangeHRM token exchange did not complete${statusSuffix(status)}, so nothing was ` +
                      'established about this credential either way.',
              );
    }

    const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };

    // ── 2. Is there an address a write could be sent TO?
    //
    // `includeEmployees=currentAndPast` mirrors the roster read: without it
    // terminated employees vanish entirely, and an instance whose only rows are
    // past employees would otherwise report an empty roster and refuse a
    // credential that is perfectly good.
    const listUrl = new URL(`https://${host}${ORANGEHRM_WEB_ROOT}/api/v2/pim/employees`);
    listUrl.searchParams.set('limit', '1');
    listUrl.searchParams.set('includeEmployees', 'currentAndPast');
    listUrl.searchParams.set('sortField', 'employee.empNumber');
    listUrl.searchParams.set('sortOrder', 'ASC');

    let listRes: Response;
    try {
        listRes = await doFetch(listUrl.toString(), { headers });
    } catch (e) {
        const { status, provenAuth } = classifyFailure(e);
        return provenAuth
            ? refuse('REFUSED_CREDENTIAL', `OrangeHRM refused the roster read${statusSuffix(status)}.`, {
                  authenticated: true,
              })
            : refuse(
                  'PREFLIGHT_INDETERMINATE',
                  `The OrangeHRM roster read did not complete${statusSuffix(status)}, so whether this ` +
                      'instance carries an addressable record is unknown.',
                  { authenticated: true },
              );
    }
    // The status branch is NOT redundant with the catch above. Production wiring
    // is `resilientFetch`, which THROWS on a classified status; an injected
    // `fetchImpl` hands the response back verbatim. `roster.ts` spells out why
    // both branches stay.
    if (!listRes.ok) {
        const provenAuth = listRes.status === 401 || listRes.status === 403;
        return provenAuth
            ? refuse('REFUSED_CREDENTIAL', `OrangeHRM refused the roster read (HTTP ${listRes.status}).`, {
                  authenticated: true,
              })
            : refuse(
                  'PREFLIGHT_INDETERMINATE',
                  `The OrangeHRM roster read did not complete (HTTP ${listRes.status}), so whether this ` +
                      'instance carries an addressable record is unknown.',
                  { authenticated: true },
              );
    }

    const listBody = (await listRes.json()) as { data?: Array<{ empNumber?: number | string | null }> | null };
    const rows = listBody.data ?? [];
    if (rows.length === 0) {
        return refuse(
            'REFUSED_NO_HANDLE',
            'The OrangeHRM roster read succeeded and returned no employees, so there is no record a ' +
                'write-back could be addressed to on this instance.',
            { authenticated: true },
        );
    }

    // `empNumber` ONLY — never `employeeId` and never the work email. The badge
    // number is editable and routinely blank, and a write addressed by work
    // email would be addressed by the value the write-back exists to CREATE
    // (design, Decision 3). `roster.ts` routes the same field to
    // `Employee.hrisRecordId`, the column Phase 0 shipped for exactly this.
    const empNumber = rows[0]?.empNumber == null ? '' : String(rows[0].empNumber).trim();
    if (!empNumber) {
        return refuse(
            'REFUSED_NO_HANDLE',
            'The OrangeHRM roster read succeeded and the first row carried no empNumber, which is the only ' +
                'field on this vendor that addresses an update.',
            { authenticated: true },
        );
    }

    // ── 3. Is the field a write would target readable at the path a write would
    // use? SINGULAR `employee` — the plural form of this one 404s, verified on
    // 5.9, and that is OrangeHRM's own inconsistency rather than a typo.
    const detailUrl = `https://${host}${ORANGEHRM_WEB_ROOT}/api/v2/pim/employee/${encodeURIComponent(empNumber)}/contact-details`;
    let detailRes: Response;
    try {
        detailRes = await doFetch(detailUrl, { headers });
    } catch (e) {
        const { status, provenAuth } = classifyFailure(e);
        if (provenAuth) {
            return refuse(
                'REFUSED_CREDENTIAL',
                `OrangeHRM refused the per-record contact-details read${statusSuffix(status)}, so this ` +
                    'credential cannot reach the record a write-back would address.',
                { authenticated: true, handleObserved: true },
            );
        }
        if (status === 404) {
            return refuse(
                'REFUSED_IDENTITY_FIELD_UNREADABLE',
                `OrangeHRM has no contact-details record for employee ${empNumber}${statusSuffix(status)}, so ` +
                    `the ${ORANGEHRM_IDENTITY_FIELD} field a write-back would target cannot be read on the ` +
                    'path the write would use.',
                { authenticated: true, handleObserved: true },
            );
        }
        return refuse(
            'PREFLIGHT_INDETERMINATE',
            `The OrangeHRM contact-details read did not complete${statusSuffix(status)}, so whether the ` +
                `${ORANGEHRM_IDENTITY_FIELD} field is reachable is unknown.`,
            { authenticated: true, handleObserved: true },
        );
    }
    if (!detailRes.ok) {
        if (detailRes.status === 401 || detailRes.status === 403) {
            return refuse(
                'REFUSED_CREDENTIAL',
                `OrangeHRM refused the per-record contact-details read (HTTP ${detailRes.status}), so this ` +
                    'credential cannot reach the record a write-back would address.',
                { authenticated: true, handleObserved: true },
            );
        }
        if (detailRes.status === 404) {
            return refuse(
                'REFUSED_IDENTITY_FIELD_UNREADABLE',
                `OrangeHRM has no contact-details record for employee ${empNumber} (HTTP 404), so the ` +
                    `${ORANGEHRM_IDENTITY_FIELD} field a write-back would target cannot be read on the path ` +
                    'the write would use.',
                { authenticated: true, handleObserved: true },
            );
        }
        return refuse(
            'PREFLIGHT_INDETERMINATE',
            `The OrangeHRM contact-details read did not complete (HTTP ${detailRes.status}), so whether the ` +
                `${ORANGEHRM_IDENTITY_FIELD} field is reachable is unknown.`,
            { authenticated: true, handleObserved: true },
        );
    }

    const contact = ((await detailRes.json()) as { data?: Record<string, unknown> | null }).data ?? {};
    // PRESENCE OF THE KEY, not truthiness of the value. A 5.9 instance returns
    // sibling keys as explicit `null`, so an ABSENT key means absent from the
    // shape — and an explicit null is the EXPECTED pre-hire state, which is the
    // case the write exists for. Reading emptiness as unreadable would refuse
    // every instance the feature is for.
    const fieldPresent = Object.prototype.hasOwnProperty.call(contact, ORANGEHRM_IDENTITY_FIELD);
    if (!fieldPresent) {
        return refuse(
            'REFUSED_IDENTITY_FIELD_UNREADABLE',
            `OrangeHRM served contact-details for employee ${empNumber} with no ${ORANGEHRM_IDENTITY_FIELD} ` +
                'key at all, so this instance does not expose the field a write-back would target. The key ' +
                'being absent is not the same as the field being empty: an empty field comes back as an ' +
                'explicit null.',
            { authenticated: true, handleObserved: true },
        );
    }

    return writeBackPreflightResult({
        outcome: 'WRITE_PATH_READABLE',
        provider,
        authenticated: true,
        handleObserved: true,
        identityFieldReadable: true,
        detail:
            `The stored credential authenticated, employee ${empNumber} is addressable by empNumber, and ` +
            `the ${ORANGEHRM_IDENTITY_FIELD} field was read at the per-record contact-details path a ` +
            'write-back would use. Whether this credential may WRITE is not established — proving that ' +
            'requires a write, which is Phase 2 of docs/jml-hris-write-back-design.md.',
    });
}
