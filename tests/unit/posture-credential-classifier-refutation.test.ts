/**
 * The posture credential trigger, as an executable record (#2413).
 *
 * Companion to
 * `docs/implementation-notes/2026-09-19-posture-credential-trigger-research-record.md`.
 * An abandoned branch (`4d891b6ac`, never PR'd, now deleted from origin) built a
 * stderr classifier that would mark a posture connection credential-revoked. It
 * was refuted three times and must not be revived. The prose record carries the
 * argument; this file carries the two halves that can be RUN, because a
 * refutation that lives only in a markdown file cannot fail when someone
 * re-derives the refuted design.
 *
 * ┌── PART 1 ── the SHIPPED discriminator, exercised directly ─────────────┐
 * │ `noControlObserved` is main's answer: it reads no provider text at all  │
 * │ and keys on breadth. This is the first direct unit test of the          │
 * │ predicate itself — it was reached only through the two collectors.      │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ┌── PART 2 ── the REFUTED classifier, reconstructed ─────────────────────┐
 * │ The parked matcher is reproduced here verbatim from `4d891b6ac` and     │
 * │ from §1.2 of the note. NOTHING IN `src/` IMPORTS IT AND NOTHING SHOULD. │
 * │ It exists so that R1 and R3 are demonstrations rather than assertions:  │
 * │ the strings a HEALTHY account emits are fed to it and it convicts them. │
 * │ This is a claim about the SHAPE of that design, not about a module —    │
 * │ any allowlist carrying `AuthFailure` inherits these results.            │
 * └────────────────────────────────────────────────────────────────────────┘
 */
import {
    noControlObserved,
    type PowerpipeObservationCounts,
} from '@/app-layer/integrations/cloud-posture/powerpipe-exit';

// ─────────────────────────────────────────────────────────────────────────
// Fixtures: the strings at the centre of the research.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The fixture the parked branch's own suite pinned as meaning "credential
 * revoked" — and, character for character, what a HEALTHY account emits for a
 * disabled opt-in region (steampipe-plugin-aws#75). R1.
 */
const HEALTHY_ACCOUNT_OPT_IN_REGION =
    'Error: operation error EC2: DescribeInstances, https response error StatusCode: 401, '
    + 'api error AuthFailure: AWS was not able to validate the provided access credentials';

/**
 * AWS's own EC2 error reference definition of `AuthFailure`. Authentication,
 * AUTHORIZATION and BILLING under one code — the region-independent refutation
 * that no configuration removes. R3.
 */
const AWS_EC2_REFERENCE_AUTHFAILURE_MEANING =
    'AuthFailure: The provided credentials could not be validated. You might not be authorized '
    + 'to carry out the request; for example, trying to associate an Elastic IP address that is '
    + 'not yours. Ensure that your account is authorized to use Amazon EC2, that your credit card '
    + 'details are correct, and that you are using the correct credentials.';

/**
 * Google's response to COLLECTOR-HOST CLOCK SKEW against a perfectly valid
 * service-account key. The parked allowlist carried `invalid_grant` while the
 * same module excluded `RequestExpired`/`RequestTimeTooSkewed` for accusing our
 * own host — it refutes its own entry. R3, second half.
 */
const GCP_CLOCK_SKEW =
    'Error: oauth2: cannot fetch token: 400 Bad Request\nResponse: '
    + '{"error":"invalid_grant","error_description":"Invalid JWT: Token must be a short-lived '
    + 'token (60 minutes) and in a reasonable timeframe"}';

/** A genuinely rejected credential. The positive control for Part 2. */
const GENUINELY_REJECTED =
    'Error: operation error STS: GetCallerIdentity, https response error StatusCode: 403, '
    + 'api error ExpiredToken: The security token included in the request is expired';

const counts = (c: Partial<PowerpipeObservationCounts>): PowerpipeObservationCounts => ({
    ok: 0, alarm: 0, skip: 0, error: 0, unknown: 0, total: 0, ...c,
});

// ─────────────────────────────────────────────────────────────────────────
// PART 1 — the shipped discriminator. Real source, real behaviour.
// ─────────────────────────────────────────────────────────────────────────

describe('noControlObserved — the breadth discriminator that replaced the classifier', () => {
    it('is TRUE only when a completed run parsed controls and every one errored', () => {
        expect(noControlObserved(counts({ error: 40, total: 40 }), 'completed-control-errors')).toBe(true);
    });

    it('is FALSE when a single control was observed — the R1 false positive, killed by breadth', () => {
        // A healthy account with one disabled opt-in region: the opt-in controls
        // error with `AuthFailure`, everything else answers normally. One `ok`
        // anywhere is proof the credential authenticated, so no text needs
        // reading. This is the exact case the parked classifier convicted.
        expect(noControlObserved(counts({ ok: 12, error: 28, total: 40 }), 'completed-control-errors')).toBe(false);
        // An alarm is equally proof of authentication — a real finding, not a
        // rejection.
        expect(noControlObserved(counts({ alarm: 1, error: 39, total: 40 }), 'completed-control-errors')).toBe(false);
        // …and so is a skip.
        expect(noControlObserved(counts({ skip: 1, error: 39, total: 40 }), 'completed-control-errors')).toBe(false);
    });

    it('is FALSE when the run DID NOT COMPLETE — a dead collector says nothing about a credential', () => {
        // The branch keyed on exactly this state (non-zero exit), which is also
        // a SIGTERM at the timeout, a missing CLI and a network blip.
        expect(noControlObserved(counts({ error: 40, total: 40 }), 'did-not-complete')).toBe(false);
    });

    it('is FALSE when a control was UNREADABLE — that is a fact about our parse, not the account', () => {
        expect(noControlObserved(counts({ error: 39, unknown: 1, total: 40 }), 'completed-control-errors')).toBe(false);
    });

    it('is FALSE on an empty benchmark — zero controls is not evidence of rejection', () => {
        expect(noControlObserved(counts({ total: 0 }), 'completed-clean')).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// PART 2 — the refuted classifier, reconstructed. DO NOT MOVE INTO src/.
// ─────────────────────────────────────────────────────────────────────────

/** The parked allowlist, verbatim from `4d891b6ac`. */
const PARKED_ALLOWLIST: readonly string[] = [
    'ExpiredToken', 'ExpiredTokenException', 'InvalidClientTokenId',
    'UnrecognizedClientException', 'InvalidAccessKeyId', 'SignatureDoesNotMatch',
    'AuthFailure',
    'AADSTS7000215', 'AADSTS7000222', 'InvalidAuthenticationToken',
    'ExpiredAuthenticationToken',
    'UNAUTHENTICATED',
    'invalid_grant', 'invalid_client', 'unauthorized_client',
];

/** The parked matcher, verbatim: case-SENSITIVE, word-bounded, first match wins. */
function parkedClassifier(stderr: string | null | undefined): string | null {
    if (!stderr) return null;
    for (const code of PARKED_ALLOWLIST) {
        if (new RegExp(`\\b${code}\\b`).test(stderr)) return code;
    }
    return null;
}

describe('the parked stderr classifier — why it must not be revived', () => {
    it('CONTROL: it does classify a genuinely rejected credential', () => {
        // Without this the three refutations below could be satisfied by a
        // matcher that simply never fires. The design is precise; it is WRONG,
        // which is a different thing and the reason it survived 27 mutations.
        expect(parkedClassifier(GENUINELY_REJECTED)).toBe('ExpiredToken');
    });

    it('R1: convicts a HEALTHY account whose opt-in region is disabled', () => {
        // The branch's own suite asserted this string means "revoked". It is
        // what a working credential produces. The trigger would have told a
        // customer to rotate a key that was fine.
        expect(parkedClassifier(HEALTHY_ACCOUNT_OPT_IN_REGION)).toBe('AuthFailure');
    });

    it('R3: convicts on AWS\'s own definition, which spans authz and BILLING', () => {
        // Region-independent, and fatal to the allowlist's organising principle:
        // the list exists to separate authentication from authorization, and its
        // most prominent AWS entry is defined by AWS to cover both — plus an
        // out-of-date credit card. No configuration removes this.
        expect(parkedClassifier(AWS_EC2_REFERENCE_AUTHFAILURE_MEANING)).toBe('AuthFailure');
    });

    it('R3b: convicts on OUR OWN host clock skew, which the module excluded by name', () => {
        // The parked module excluded `RequestExpired`/`RequestTimeTooSkewed` for
        // accusing the collector host rather than the customer — then admitted
        // `invalid_grant`, which Google returns for precisely that.
        expect(parkedClassifier(GCP_CLOCK_SKEW)).toBe('invalid_grant');
    });

    it('R2: is INERT on the real collection path — powerpipe puts control errors on STDOUT', () => {
        // `ControlRun.setError` stores the text in `RunErrorString`, the JSON
        // template renders it as `run_error`, and every formatter drains to
        // stdout; powerpipe reaches steampipe as a postgres client, so there is
        // no child stderr to merge. `res.stderr` for an ordinary
        // `powerpipe benchmark run` is empty — so even a genuinely revoked
        // credential yields no verdict, and the fix would have been a no-op that
        // retired the ticket recording the problem.
        expect(parkedClassifier('')).toBeNull();
        expect(parkedClassifier(null)).toBeNull();
        expect(parkedClassifier(undefined)).toBeNull();
    });

    it('keeps the AUTHORIZATION exclusions the record says are still correct', () => {
        // The one part of the design that survives: a read-only posture role
        // short a single `Describe*` emits these while the credential is fine.
        for (const authz of [
            'api error AccessDenied: User is not authorized to perform: s3:GetBucketAcl',
            'api error AccessDeniedException: explicit deny in an SCP',
            'api error UnauthorizedOperation: You are not authorized to perform this operation',
            'code: PERMISSION_DENIED, message: Permission compute.instances.list denied',
            'AuthorizationFailed: The client does not have authorization to perform action',
        ]) {
            expect(parkedClassifier(authz)).toBeNull();
        }
    });
});
