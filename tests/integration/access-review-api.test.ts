/**
 * Epic G-4 — API contract tests for the access-review surface.
 *
 * Static / structural tests that prove:
 *   • Each route exists at the expected path
 *   • Each route delegates to the correct usecase
 *   • Each mutation route uses `withValidatedBody` with the right schema
 *   • Both UI pages exist + reach into their client islands
 *
 * Runtime + permission semantics are exercised by the usecase
 * integration tests; this file is the wiring ratchet.
 */
import * as fs from 'node:fs';
import path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
function read(rel: string): string {
    return codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
}

describe('Epic G-4 — access-review API + UI wiring', () => {
    const listRoute = read(
        'src/app/api/t/[tenantSlug]/access-reviews/route.ts',
    );
    const detailRoute = read(
        'src/app/api/t/[tenantSlug]/access-reviews/[reviewId]/route.ts',
    );
    const decisionRoute = read(
        'src/app/api/t/[tenantSlug]/access-reviews/[reviewId]/decisions/[decisionId]/route.ts',
    );
    const closeRoute = read(
        'src/app/api/t/[tenantSlug]/access-reviews/[reviewId]/close/route.ts',
    );
    const evidenceRoute = read(
        'src/app/api/t/[tenantSlug]/access-reviews/[reviewId]/evidence/route.ts',
    );
    const listPage = read(
        'src/app/t/[tenantSlug]/(app)/access-reviews/page.tsx',
    );
    const listClient = read(
        'src/app/t/[tenantSlug]/(app)/access-reviews/AccessReviewsClient.tsx',
    );
    const detailPage = read(
        'src/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/page.tsx',
    );
    const detailClient = read(
        'src/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient.tsx',
    );

    // ── 1. Route surface exists + delegates ────────────────────────

    it('GET /access-reviews delegates to listAccessReviews', () => {
        expect(listRoute).toMatch(/export const GET/);
        expect(listRoute).toContain('listAccessReviews');
        // Backfill cap discipline like every other list route.
        expect(listRoute).toContain('LIST_BACKFILL_CAP');
        expect(listRoute).toContain('applyBackfillCap');
        expect(listRoute).toContain('recordListPageRowCount');
    });

    it('POST /access-reviews validates with CreateAccessReviewSchema and calls createAccessReview', () => {
        expect(listRoute).toMatch(/export const POST/);
        expect(listRoute).toContain('CreateAccessReviewSchema');
        // Step 5a — `parseJsonBody` inside the handler, NOT `withValidatedBody`.
        // Both wrappers claim the third handler argument, which
        // `requirePermission` needs for `ctx`, so they cannot compose. The
        // replacement is also the better order: authorisation runs BEFORE the
        // body is parsed, and its denial writes an `AUTHZ_DENIED` row.
        // LITERAL needles, each occurring exactly once. A regex carrying a
        // span (`[^>]*`, `[\s\S]*?`) is invisible to the needle-uniqueness
        // analyser — it lands in `needle-carries-span` and becomes a blind
        // spot where an ambiguous assertion can hide. The bare identifier
        // `parseJsonBody` is no good either: it appears at the import AND the
        // call. The call site with its schema is unique and is the real claim.
        expect(listRoute).toContain('parseJsonBody(req, CreateAccessReviewSchema)');
        expect(listRoute).not.toContain('withValidatedBody');
        expect(listRoute).toContain("'access_reviews.create'");
        expect(listRoute).toContain('createAccessReview');
    });

    it('GET /access-reviews/:reviewId delegates to getAccessReviewWithActivity', () => {
        expect(detailRoute).toMatch(/export const GET/);
        expect(detailRoute).toContain('getAccessReviewWithActivity');
    });

    it('PUT decisions route validates with SubmitDecisionSchema and calls submitDecision', () => {
        expect(decisionRoute).toMatch(/export const PUT/);
        expect(decisionRoute).toContain('SubmitDecisionSchema');
        expect(decisionRoute).toContain('parseJsonBody(req, SubmitDecisionSchema)');
        expect(decisionRoute).not.toContain('withValidatedBody');
        expect(decisionRoute).toContain("'access_reviews.decide'");
        expect(decisionRoute).toContain('submitDecision');
    });

    it('POST close route delegates to closeAccessReview', () => {
        expect(closeRoute).toMatch(/export const POST/);
        expect(closeRoute).toContain('closeAccessReview');
    });

    it('GET evidence route asserts read + uses storage provider stream', () => {
        expect(evidenceRoute).toMatch(/export const GET/);
        // Step 5a — the inline `assertCanRead` became
        // `requirePermission('access_reviews.view')`. Same caller set (canRead
        // is every role), stronger record: the inline assert threw without
        // writing anything, so a refused evidence download left no trace.
        expect(evidenceRoute).not.toContain('assertCanRead');
        expect(evidenceRoute).toContain("'access_reviews.view'");
        expect(evidenceRoute).toContain('readStream');
        expect(evidenceRoute).toContain('Content-Disposition');
        // Privacy: never cache the artifact in shared caches.
        expect(evidenceRoute).toContain("Cache-Control");
        expect(evidenceRoute).toContain('private, no-store');
    });

    // ── 2. Tenant scoping invariant ─────────────────────────────────

    it('every route runs the tenant gate, now via requirePermission', () => {
        // Step 5a — `getTenantCtx` moved INSIDE `requirePermission`, which
        // resolves it (auth, tenant, membership, custom-role permissions),
        // makes the permission decision, writes `AUTHZ_DENIED` on refusal, and
        // hands the resolved `ctx` to the handler. So the tenant gate still
        // runs on every route; asserting the old call by name would now be
        // asserting that the WEAKER of the two mechanisms is present.
        //
        // The claim is kept as a loop over every route rather than narrowed to
        // one, because "every route" is the invariant — a new route arriving
        // without a gate is what this test exists to catch.
        // Route PAIRED WITH THE KEY IT MUST CARRY, rather than "some key is
        // present". A single alternation would be satisfied by the wrong key —
        // a create gated on `.view` would pass it — and that is precisely the
        // mistake the rule ordering in ROUTE_PERMISSIONS can make.
        const GATES: ReadonlyArray<[string, string]> = [
            [listRoute, "'access_reviews.view'"],
            [listRoute, "'access_reviews.create'"],
            [detailRoute, "'access_reviews.view'"],
            [decisionRoute, "'access_reviews.decide'"],
            [closeRoute, "'access_reviews.close'"],
            [evidenceRoute, "'access_reviews.view'"],
        ];
        for (const [src, key] of GATES) {
            expect(src).toContain(key);
            // And not the bare pre-5a shape, which authorised nothing at the
            // route and therefore recorded no refusal.
            expect(src).not.toContain('const ctx = await getTenantCtx(');
        }
    });

    // ── 3. Pages exist + import their client islands ───────────────

    it('list page exists, force-dynamic, and mounts AccessReviewsClient', () => {
        expect(listPage).toContain("'force-dynamic'");
        expect(listPage).toContain('AccessReviewsClient');
        expect(listPage).toContain('listAccessReviews');
    });

    it('detail page exists, force-dynamic, and mounts AccessReviewDetailClient', () => {
        expect(detailPage).toContain("'force-dynamic'");
        expect(detailPage).toContain('AccessReviewDetailClient');
        expect(detailPage).toContain('getAccessReviewWithActivity');
    });

    // ── 4. List client surface — title + create button + table ─────

    it('list client surfaces the title, create-button, progress bar, and a row testid', () => {
        expect(listClient).toContain('access-reviews-title');
        expect(listClient).toContain('access-review-new-campaign-button');
        expect(listClient).toContain('ProgressBar');
        // Per-row testid uses the campaign id — the smoke test below
        // looks for the prefix.
        expect(listClient).toContain('access-review-row-');
    });

    // ── 5. Detail client — decision dropdown + close + download ────

    it('detail client has decision dropdown + close + download-evidence affordances', () => {
        expect(detailClient).toContain('decision-select-');
        expect(detailClient).toContain('decision-modal-submit');
        expect(detailClient).toContain('access-review-close-button');
        expect(detailClient).toContain('access-review-download-evidence');
        // Decision flow always goes through the API — never a direct
        // mutation against the row from the page.
        expect(detailClient).toContain("/decisions/");
        expect(detailClient).toContain("/close");
    });

    // ── 6. Permission gating in the detail client ──────────────────

    it('detail client gates Close on isAdmin and DecisionDialog on canDecide', () => {
        // canDecide gate (assigned reviewer OR admin), CLOSED rejects.
        // The DECLARATIONS, not the bare identifiers. `toContain('canDecide')`
        // was satisfied by any use of the variable, and Step 5a added two more
        // call sites for the connected table — five positions, at which the
        // needle stops naming the gate it is about.
        expect(detailClient).toMatch(/const isReviewer\s*=/);
        expect(detailClient).toMatch(/const canDecide\s*=\s*\(isReviewer \|\| isAdmin\)/);
        expect(detailClient).toMatch(/const canClose\s*=\s*isAdmin/);
    });
});
