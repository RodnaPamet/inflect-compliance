/**
 * #3297 — the time-bounded access package grant, and the refusals that bound it.
 *
 * WHAT IS ACTUALLY BEING PROTECTED
 * ────────────────────────────────
 * Not "a POST is sent with the right fields". The three assertions carrying
 * weight here are the ones that stay true when somebody later makes this
 * function more convenient:
 *
 *   1. AN ABSENT EXPIRY IS A REFUSAL, NOT A DEFAULT. The way a product acquires
 *      permanent access grants by accident is an optional expiry omitted from
 *      one call. A test that only checks the happy path would stay green through
 *      exactly that change.
 *   2. A REFUSED GRANT SENDS NOTHING. Not "sends and is rejected" — the far end
 *      must not observe the attempt at all, so the fetch double counts its calls
 *      and the refusal arms assert ZERO. A refusal computed after the request
 *      is a refusal that already leaked.
 *   3. THE CAP REFUSES RATHER THAN CLAMPS. Silently shortening a 180-day request
 *      to 90 returns success for an operation nobody asked for, and the operator
 *      finds out when access vanishes mid-project. The assertion is on the
 *      refusal, and there is a paired assertion that nothing was sent.
 *
 * WHY THE BOUNDARY IS TESTED FROM BOTH SIDES
 * ──────────────────────────────────────────
 * A cap asserted only from outside passes for a function that refuses
 * everything. Both arms are derived from `MAX_GRANT_DAYS` rather than written as
 * 90, for `external-tool-target-population`'s reason about its freshness window:
 * a fixture that happened to sit outside a GUESSED bound keeps passing after
 * somebody widens the real one.
 */
import {
    classifyAssignment,
    createEntraEntitlementClient,
    expiryRefusal,
    MAX_GRANT_DAYS,
    type TimeBoundedGrantInput,
} from '@/app-layer/integrations/providers/entra-id/entitlement';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-08T12:00:00.000Z');

/** A real-shaped Entra object id — `assertEntraObjectId` rejects anything else. */
const TARGET = '46184453-e63b-4f20-86c2-c557ed5d5df9';
const PACKAGE = 'a914b616-e04e-476b-aa37-91038f0b165b';
const POLICY = '2264bf65-76ba-417b-a27d-54d291f0cbc8';

const grant = (over: Partial<TimeBoundedGrantInput> = {}): TimeBoundedGrantInput => ({
    targetId: TARGET,
    accessPackageId: PACKAGE,
    assignmentPolicyId: POLICY,
    endDateTime: new Date(NOW.getTime() + 7 * DAY_MS),
    ...over,
});

/** A fetch double that RECORDS, so "nothing was sent" is assertable. */
function recordingFetch(reply: { status?: number; body?: unknown }) {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const impl = (async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        // The token exchange goes through the same impl; answer it first.
        if (String(url).includes('/oauth2/v2.0/token')) {
            return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        return new Response(JSON.stringify(reply.body ?? {}), {
            status: reply.status ?? 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }) as unknown as typeof fetch;
    return {
        impl,
        calls,
        /**
         * Hostname EQUALITY, not a substring.
         *
         * CodeQL flagged `c.url.includes('graph.microsoft.com')` as
         * `js/incomplete-url-substring-sanitization`, HIGH, and it is right about
         * the pattern: `https://evil.test/?x=graph.microsoft.com` satisfies a
         * substring check. There is no attacker inside a test double, so this is
         * not a vulnerability being fixed — but "it is only a test" is how a
         * pattern survives long enough to be copied into a place where it is one,
         * and this repo keeps a ratchet specifically to stop security gates being
         * quietly lowered.
         *
         * It is also the better TEST. These assertions distinguish the calls that
         * went to Graph from the token exchange that went to `login.microsoft…`,
         * and a substring match would equally accept a host that merely MENTIONS
         * Graph in a query string. Equality asks the question the assertions mean.
         */
        graphCalls: () =>
            calls.filter((c) => {
                try {
                    return new URL(c.url).hostname === 'graph.microsoft.com';
                } catch {
                    return false;
                }
            }),
    };
}

const CONNECTION = {
    tenantId: '0fc6f345-0eee-4408-89a9-96fdd1b6439d',
    clientId: 'e8c77dc2-69b3-43f4-bc51-3213c9d915b4',
    clientSecret: 'not-a-real-secret', // pragma: allowlist secret -- test fixture
};

const clientWith = (fetchImpl: typeof fetch) =>
    createEntraEntitlementClient({
        connection: CONNECTION,
        doFetch: fetchImpl,
        now: () => NOW,
    });

// ═════════════════════════════════════════════════════════════════════
// 1. THE EXPIRY REFUSALS — pure, no network
// ═════════════════════════════════════════════════════════════════════

describe('expiryRefusal — an unbounded grant is refused, never defaulted', () => {
    it('allows a grant comfortably inside the window — the control', () => {
        expect(expiryRefusal(grant(), NOW)).toBeNull();
    });

    it('refuses an Invalid Date, which is what a parsed form field produces', () => {
        // `new Date('next friday')` is an Invalid Date whose getTime() is NaN,
        // and every comparison against NaN is false — so an unchecked one sails
        // through BOTH bounds and reaches Graph as the string "Invalid Date".
        const r = expiryRefusal(grant({ endDateTime: new Date('next friday') }), NOW);
        expect(r).toMatch(/missing or unparseable/);
        expect(r).toMatch(/no permanent-assignment path/);
    });

    it('refuses an end date already in the past', () => {
        expect(expiryRefusal(grant({ endDateTime: new Date(NOW.getTime() - 1) }), NOW)).toMatch(
            /not in the future/,
        );
    });

    it('refuses an end date exactly NOW — an assignment that expires as it is made', () => {
        // The `<=` boundary. A grant expiring at the instant it is created reads
        // as a successful grant that silently did nothing.
        expect(expiryRefusal(grant({ endDateTime: new Date(NOW.getTime()) }), NOW)).toMatch(
            /not in the future/,
        );
    });

    it(`refuses beyond the ${MAX_GRANT_DAYS}-day cap, and says why rather than clamping`, () => {
        const r = expiryRefusal(
            grant({ endDateTime: new Date(NOW.getTime() + (MAX_GRANT_DAYS + 1) * DAY_MS) }),
            NOW,
        );
        expect(r).toMatch(new RegExp(`${MAX_GRANT_DAYS}-day maximum`));
        // The REASON is load-bearing copy: the cap is the recertification
        // interval, not a round number, and an operator who does not know that
        // will read the refusal as arbitrary and ask for it to be raised.
        expect(r).toMatch(/recertification interval/);
        expect(r).toMatch(/not clamped/i);
    });

    it('allows a grant exactly AT the cap — the boundary control', () => {
        // Paired with the test above so the refusal is about the window and not
        // about any long-ish grant being rejected. Derived from the constant,
        // never written as 90.
        expect(
            expiryRefusal(
                grant({ endDateTime: new Date(NOW.getTime() + MAX_GRANT_DAYS * DAY_MS) }),
                NOW,
            ),
        ).toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. A REFUSED GRANT SENDS NOTHING
// ═════════════════════════════════════════════════════════════════════

describe('a refused grant is not observable to the far end', () => {
    it.each([
        ['an Invalid Date', new Date('nonsense')],
        ['a past end date', new Date(NOW.getTime() - DAY_MS)],
        ['beyond the cap', new Date(NOW.getTime() + (MAX_GRANT_DAYS + 30) * DAY_MS)],
    ])('%s — zero requests, not even a token exchange', async (_label, endDateTime) => {
        const f = recordingFetch({ body: { id: 'req-1' } });
        const res = await clientWith(f.impl).requestTimeBoundedAssignment(grant({ endDateTime }));

        expect(res).toHaveProperty('refused');
        // ALL calls, not just Graph: the refusal runs before `auth()`, so even
        // the token exchange must not have happened. A refusal computed after
        // the credential round trip has already told Microsoft we were asking.
        expect(f.calls).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. THE REQUEST ENTRA ACTUALLY RECEIVES
// ═════════════════════════════════════════════════════════════════════

describe('requestTimeBoundedAssignment — the body Entra receives', () => {
    async function sentBody(over: Partial<TimeBoundedGrantInput> = {}) {
        const f = recordingFetch({ body: { id: 'req-1' } });
        const res = await clientWith(f.impl).requestTimeBoundedAssignment(grant(over));
        const post = f.graphCalls().find((c) => c.init?.method === 'POST');
        return { res, post, body: post ? JSON.parse(String(post.init?.body)) : null, f };
    }

    it('posts to assignmentRequests and returns the request id', async () => {
        const { res, post } = await sentBody();
        expect(post?.url).toContain('/identityGovernance/entitlementManagement/assignmentRequests');
        expect(res).toEqual({ requestId: 'req-1' });
    });

    it('is an adminAdd, not a self-service userAdd', async () => {
        // Different operation, different approval story. It must not be
        // reachable from here by flipping a field.
        const { body } = await sentBody();
        expect(body.requestType).toBe('adminAdd');
    });

    it('carries the native expiry — afterDateTime, so ENTRA ends it, not us', async () => {
        const end = new Date(NOW.getTime() + 14 * DAY_MS);
        const { body } = await sentBody({ endDateTime: end });
        expect(body.schedule.expiration.type).toBe('afterDateTime');
        expect(body.schedule.expiration.endDateTime).toBe(end.toISOString());
        // `duration` and `endDateTime` are alternatives; Graph rejects both.
        expect(body.schedule.expiration.duration).toBeNull();
    });

    it('names the target, the package and the policy', async () => {
        const { body } = await sentBody();
        expect(body.assignment).toEqual({
            targetId: TARGET,
            accessPackageId: PACKAGE,
            assignmentPolicyId: POLICY,
        });
    });

    it('omits justification entirely when none was given, rather than sending null', async () => {
        const { body } = await sentBody();
        expect('justification' in body).toBe(false);
    });

    it('rejects a target that is not an Entra object id, before any request', async () => {
        const f = recordingFetch({ body: { id: 'req-1' } });
        await expect(
            clientWith(f.impl).requestTimeBoundedAssignment(grant({ targetId: 'bob@corp.test' })),
        ).rejects.toThrow();
        expect(f.graphCalls()).toHaveLength(0);
    });

    it('throws rather than reporting success when Graph returns no id', async () => {
        // The assignment may well have been created. A caller recording "no id"
        // as "no grant" would be wrong in the direction that matters.
        const f = recordingFetch({ body: {} });
        await expect(
            clientWith(f.impl).requestTimeBoundedAssignment(grant()),
        ).rejects.toThrow(/returned no id/);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. THE PRIOR-STATE READ
// ═════════════════════════════════════════════════════════════════════

describe('readAssignments — the prior state the write replaces', () => {
    it('filters on BOTH the target and the package', async () => {
        // An unfiltered read pulls the tenant's whole assignment list to answer
        // a question about one person, and a prior-state record containing
        // everybody is not a record of THIS write's before-state.
        const f = recordingFetch({ body: { value: [] } });
        await clientWith(f.impl).readAssignments({ targetId: TARGET, accessPackageId: PACKAGE });
        const url = decodeURIComponent(f.graphCalls()[0]?.url ?? '');
        expect(url).toContain(`target/objectId eq '${TARGET}'`);
        expect(url).toContain(`accessPackage/id eq '${PACKAGE}'`);
    });

    it('returns the end date of an existing assignment, so an extension is visible', async () => {
        const f = recordingFetch({
            body: {
                value: [
                    {
                        id: 'asg-1',
                        state: 'Delivered',
                        accessPackage: { id: PACKAGE },
                        schedule: { expiration: { endDateTime: '2026-11-01T00:00:00Z' } },
                    },
                ],
            },
        });
        const read = await clientWith(f.impl).readAssignments({
            targetId: TARGET,
            accessPackageId: PACKAGE,
        });
        expect(read.all).toEqual([
            {
                assignmentId: 'asg-1',
                accessPackageId: PACKAGE,
                state: 'Delivered',
                endDateTime: '2026-11-01T00:00:00Z',
                liveness: 'live',
            },
        ]);
        // Ends after NOW, so it is a current holding and appears in BOTH.
        expect(read.live).toEqual(read.all);
    });

    it('drops a row with no id rather than carrying a record with a hole in it', async () => {
        const f = recordingFetch({ body: { value: [{ state: 'Delivered' }, { id: 'asg-2' }] } });
        const read = await clientWith(f.impl).readAssignments({
            targetId: TARGET,
            accessPackageId: PACKAGE,
        });
        expect(read.all.map((r) => r.assignmentId)).toEqual(['asg-2']);
    });

    it('reports an empty result as empty, and a FAILED read as an error', async () => {
        // Distinguishing these is the whole point: "nothing assigned" and "the
        // read did not happen" must never arrive as the same value.
        const empty = recordingFetch({ body: { value: [] } });
        await expect(
            clientWith(empty.impl).readAssignments({ targetId: TARGET, accessPackageId: PACKAGE }),
        ).resolves.toEqual({ all: [], live: [] });

        const broken = recordingFetch({
            status: 403,
            body: { error: { code: 'Authorization_RequestDenied', message: 'no' } },
        });
        await expect(
            clientWith(broken.impl).readAssignments({ targetId: TARGET, accessPackageId: PACKAGE }),
        ).rejects.toThrow(/Authorization_RequestDenied/);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. LIVENESS — #3326. AN EXPIRED ASSIGNMENT IS NOT A HOLDING
// ═════════════════════════════════════════════════════════════════════

/**
 * WHAT IS BEING PROTECTED, AND WHICH DIRECTION THE ERROR RUNS
 * ──────────────────────────────────────────────────────────
 * Graph does not remove an expired assignment — it stays in the collection with
 * `state: Expired`. So a read filtered on subject and package returns history
 * mixed with holdings, and the question "do they already have this" cannot be
 * answered by the row COUNT.
 *
 * The direction matters more than the fact. A subject whose only assignment
 * expired last month has exactly one row, so `length > 0` reads TRUE — and a
 * caller concluding "already held, the grant is a no-op" SUPPRESSES the grant
 * that would have restored their access. A denial of access dressed as an
 * optimisation, backed by a real assignment with a real end date, so nothing in
 * the journal looks wrong. That is why the shape changed rather than the
 * docblock.
 */
describe('classifyAssignment — state alone does not answer it', () => {
    const at = NOW; // 2026-10-08T12:00:00.000Z
    const FUTURE = '2026-11-01T00:00:00Z';
    const PAST = '2026-09-01T00:00:00Z';

    it.each([
        // The load-bearing pair: same state, opposite verdicts.
        ['delivered, ending later', 'delivered', FUTURE, 'live'],
        ['delivered, ALREADY ENDED', 'delivered', PAST, 'inactive'],

        // Case. The live Graph payload is lowercase; the docs and the portal
        // filter say `Delivered`. A comparison pinned to either spelling passes
        // against a fixture written from the other and fails against the API.
        ['the docs spelling', 'Delivered', FUTURE, 'live'],
        ['shouting', 'DELIVERED', FUTURE, 'live'],
        ['padded', '  delivered  ', FUTURE, 'live'],

        // No expiry is a permanent holding, not a missing one.
        ['delivered with no end date', 'delivered', null, 'live'],
        ['delivered with an empty end date', 'delivered', '', 'live'],

        // In flight: not held yet, and NOT history. Filing these under a
        // `historical` bucket would be this very defect a second time.
        ['delivering', 'delivering', FUTURE, 'pending'],
        ['partially delivered', 'partiallyDelivered', FUTURE, 'pending'],

        ['expired', 'expired', PAST, 'inactive'],
        ['delivery failed', 'deliveryFailed', FUTURE, 'inactive'],

        // Unknown is a real answer and never collapses into inactive.
        ['no state at all', null, FUTURE, 'unknown'],
        ['an empty state', '', FUTURE, 'unknown'],
        ['a state added to the enum later', 'unknownFutureValue', FUTURE, 'unknown'],
        ['a date that will not parse', 'delivered', 'not-a-date', 'unknown'],
    ])('%s', (_label, state, end, expected) => {
        expect(classifyAssignment(state, end, at)).toBe(expected);
    });

    it('an assignment ending EXACTLY now is inactive, not live', () => {
        // The boundary is strict: `end > now`. An assignment whose window has
        // closed to the millisecond is not a holding, and picking the inclusive
        // side here would make the no-op suppression win a tie.
        expect(classifyAssignment('delivered', at.toISOString(), at)).toBe('inactive');
        expect(classifyAssignment('delivered', new Date(at.getTime() + 1).toISOString(), at)).toBe(
            'live',
        );
    });

    it('a delivered row with a PAST end date is inactive — the #3324 window', () => {
        // Measured live: an assignment sat at `state=delivered` with an
        // endDateTime already in the past. Inside that window Entra has not yet
        // processed the expiry, so neither field alone is trustworthy and the
        // tie breaks toward ATTEMPTING the write: a rejected duplicate is a
        // visible error, a suppressed grant is a silent denial.
        expect(classifyAssignment('delivered', PAST, at)).toBe('inactive');
    });
});

describe('readAssignments — `all` keeps the history, `live` answers the question', () => {
    const row = (id: string, state: string, endDateTime: string | null) => ({
        id,
        state,
        accessPackage: { id: PACKAGE },
        schedule: { expiration: { endDateTime } },
    });

    it('a subject whose ONLY assignment expired holds nothing — the defect', async () => {
        const f = recordingFetch({
            body: { value: [row('asg-old', 'expired', '2026-09-01T00:00:00Z')] },
        });
        const read = await clientWith(f.impl).readAssignments({
            targetId: TARGET,
            accessPackageId: PACKAGE,
        });
        // The shape that was wrong: one row, so `length > 0` said "already has
        // it" and the grant would have been suppressed.
        expect(read.all).toHaveLength(1);
        expect(read.live).toHaveLength(0);
        // And the row is KEPT, because "previously held this until 2026-09-01"
        // is exactly what an assessor wants from a prior-state record.
        expect(read.all[0].liveness).toBe('inactive');
        expect(read.all[0].endDateTime).toBe('2026-09-01T00:00:00Z');
    });

    it('separates a live holding from the lapsed ones beside it', async () => {
        const f = recordingFetch({
            body: {
                value: [
                    row('asg-old', 'expired', '2026-09-01T00:00:00Z'),
                    row('asg-now', 'delivered', '2026-11-01T00:00:00Z'),
                    row('asg-queued', 'delivering', '2026-11-01T00:00:00Z'),
                ],
            },
        });
        const read = await clientWith(f.impl).readAssignments({
            targetId: TARGET,
            accessPackageId: PACKAGE,
        });
        expect(read.all).toHaveLength(3);
        expect(read.live.map((r) => r.assignmentId)).toEqual(['asg-now']);
        // `delivering` is in neither `live` nor forgotten: it is pending, and a
        // caller can tell "a grant is already in flight" from "they held it and
        // it lapsed" — two different operator actions.
        expect(read.all.map((r) => r.liveness)).toEqual(['inactive', 'live', 'pending']);
    });

    it('classifies the whole batch against ONE clock reading', async () => {
        // Two rows with the SAME end date must land in the same bucket. Reading
        // the clock per row could straddle a boundary and split them, which is
        // not a thing the directory said.
        const same = '2026-10-08T12:00:00.000Z'; // exactly NOW
        const f = recordingFetch({
            body: { value: [row('a', 'delivered', same), row('b', 'delivered', same)] },
        });
        const read = await clientWith(f.impl).readAssignments({
            targetId: TARGET,
            accessPackageId: PACKAGE,
        });
        expect(new Set(read.all.map((r) => r.liveness)).size).toBe(1);
    });
});
