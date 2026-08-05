/**
 * Epic 54 — Create Control modal migration contract.
 *
 * Node-env jest can't render .tsx, so this suite source-inspects the
 * migrated surface:
 *
 *   1. The modal component exists, uses the shared <Modal> primitives,
 *      and composes Body / Actions through <Modal.Form>.
 *   2. Every existing E2E form ID is preserved so the pre-migration test
 *      suite continues to pass untouched (no ratchet bump required).
 *   3. Business behaviour is intact — same POST body, same applicability
 *      follow-up, same post-create navigation, same React-Query cache
 *      invalidation.
 *   4. The legacy /controls/new page is now a server-side redirect shim
 *      so deep links keep working against the modal-based flow.
 *   5. ControlsClient wires the trigger + auto-opens on `?create=1`.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../');
function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

const MODAL_SRC = read('src/app/t/[tenantSlug]/(app)/controls/NewControlModal.tsx');
const CLIENT_SRC = read('src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx');
const NEW_PAGE_SRC = read('src/app/t/[tenantSlug]/(app)/controls/new/page.tsx');
// User-facing strings migrated to next-intl; resolve keys against en.json.
const EN_CONTROLS = JSON.parse(read('messages/en.json')).controls as {
    new: Record<string, string>;
};

// ─── 1. Modal composition ────────────────────────────────────────

describe('NewControlModal — shared Modal composition', () => {
    it('is a client component', () => {
        expect(MODAL_SRC).toMatch(/^'use client'/);
    });

    it('imports the shared Modal (not a bespoke overlay)', () => {
        expect(MODAL_SRC).toMatch(/from ['"]@\/components\/ui\/modal['"]/);
        expect(MODAL_SRC).not.toMatch(/fixed inset-0 bg-black/);
    });

    it('renders <Modal.Form> + <Modal.Body> + <Modal.Actions>', () => {
        expect(MODAL_SRC).toMatch(/<Modal\.Form\b/);
        expect(MODAL_SRC).toMatch(/<Modal\.Body\b/);
        expect(MODAL_SRC).toMatch(/<Modal\.Actions\b/);
    });

    it('uses size="lg" so the CRUD form breathes', () => {
        expect(MODAL_SRC).toMatch(/size=["']lg["']/);
    });

    it('passes title + description for a11y naming', () => {
        expect(MODAL_SRC).toMatch(/title=\{t\('new\.ariaTitle'\)\}/);
        expect(MODAL_SRC).toMatch(/description=\{t\('new\.desc'\)\}/);
        expect(EN_CONTROLS.new.ariaTitle).toBe('New control');
        expect(EN_CONTROLS.new.desc).toBe('Create a custom control for your register.');
    });

    it('guards close-during-save via preventDefaultClose tied to RHF isSubmitting', () => {
        // After Epic 64-FORM (RHF + zodResolver migration), the save-in-progress
        // signal comes from RHF's `formState.isSubmitting` instead of a hand-rolled
        // `saving` useState. Either name is acceptable as long as the prop is
        // wired to the live submit-pending flag.
        expect(MODAL_SRC).toMatch(
            /preventDefaultClose=\{(saving|isSubmitting)\}/,
        );
    });
});

// ─── 2. E2E ID preservation ──────────────────────────────────────

describe('NewControlModal — preserved E2E IDs', () => {
    const REQUIRED_IDS = [
        'control-name-input',
        'control-code-input',
        'control-category-input',
        'control-frequency-input',
        'control-justification-input',
        'create-control-btn',
    ];

    it.each(REQUIRED_IDS)('preserves id="%s"', (id) => {
        expect(MODAL_SRC).toMatch(new RegExp(`id=["']${id}["']`));
    });

    it('adds a cancel affordance with a dedicated id', () => {
        expect(MODAL_SRC).toMatch(/id=["']new-control-cancel-btn["']/);
    });
});

// ─── 3. Business behaviour preserved ─────────────────────────────

describe('NewControlModal — business behaviour preserved', () => {
    it('POSTs to /controls with the documented payload shape', () => {
        expect(MODAL_SRC).toMatch(/apiUrl\(['"]\/controls['"]\)/);
        expect(MODAL_SRC).toMatch(/method:\s*['"]POST['"]/);
        // Same fields as the legacy page: name, optional code, description,
        // category, frequency, isCustom=true. After the RHF migration the
        // payload is built from RHF's `values.<field>` instead of the
        // useState `form.<field>` — match either shape.
        expect(MODAL_SRC).toMatch(/name:\s*(form|values)\.name/);
        expect(MODAL_SRC).toMatch(
            /code:\s*(form|values)\.code[\s\S]*\|\|\s*undefined/,
        );
        expect(MODAL_SRC).toMatch(/isCustom:\s*true/);
    });

    it('follows up with the applicability POST when user chose NOT_APPLICABLE', () => {
        // After RHF migration, the conditional reads from `values.applicability`
        // rather than the local useState. The created control's id is cached in
        // a ref (`createdControlIdRef`) so a retry after a partial failure does
        // NOT recreate the control; the follow-up POST addresses the created
        // record via the local `createdId` binding.
        expect(MODAL_SRC).toMatch(
            /(applicability|values\.applicability)\s*===\s*['"]NOT_APPLICABLE['"]/,
        );
        expect(MODAL_SRC).toMatch(
            /apiUrl\(`\/controls\/\$\{createdId\}\/applicability`\)/,
        );
        // On a failed applicability follow-up the modal must stay open (form
        // state, incl. the justification, is preserved for retry): the POST is
        // guarded by `res.ok` and throws — the catch surfaces the error rather
        // than closing. The created-id is cached across the failure so retry
        // re-runs ONLY this step.
        expect(MODAL_SRC).toMatch(/applicabilityRes\.ok/);
        expect(MODAL_SRC).toMatch(/createdControlIdRef/);
    });

    it('revalidates the Controls SWR list key on success (every ?qs variant)', () => {
        expect(MODAL_SRC).toMatch(/useSWRConfig/);
        expect(MODAL_SRC).toMatch(/CACHE_KEYS\.controls\.list\(\)/);
        // Predicate matcher hits the bare list key and every filter variant.
        expect(MODAL_SRC).toMatch(/key\.startsWith\(`\$\{controlsUrlPrefix\}\?`\)/);
    });

    it('navigates to the new control detail page after create (preserves downstream E2E chain)', () => {
        // The created control's id is cached in a ref and read back as the
        // local `createdId` binding; navigation targets the new entity's
        // detail page via that id.
        expect(MODAL_SRC).toMatch(
            /router\.push\(tenantHref\(`\/controls\/\$\{createdId\}`\)\)/,
        );
    });

    it('surfaces API error messages in an alert region', () => {
        expect(MODAL_SRC).toMatch(/role=["']alert["']/);
        expect(MODAL_SRC).toMatch(/id=["']new-control-error["']/);
        // Falls back to the shared "Failed to create control" message (i18n key).
        expect(MODAL_SRC).toMatch(/t\('new\.createFailed'\)/);
        expect(EN_CONTROLS.new.createFailed).toBe('Failed to create control');
    });

    it('enforces required-name + NA-needs-justification via Zod', () => {
        // After Epic 64-FORM the form rules live in a Zod schema bound
        // to RHF via zodResolver — not in a hand-rolled `canSubmit`.
        // Locking the schema invariants here keeps the contract intact
        // regardless of form-state plumbing.
        // The schema is now a `buildFormSchema(t)` factory (so validation
        // messages route through next-intl), memoised per-render in the
        // component and passed to zodResolver.
        expect(MODAL_SRC).toMatch(/const buildFormSchema = \(t/);
        expect(MODAL_SRC).toMatch(
            /const formSchema = useMemo\(\(\) => buildFormSchema\(t\)/,
        );
        expect(MODAL_SRC).toMatch(/zodResolver\(formSchema\)/);
        // Required name:
        expect(MODAL_SRC).toMatch(/name:\s*z\.string\(\)\.min\(1/);
        // Cross-field rule for NOT_APPLICABLE → justification required:
        expect(MODAL_SRC).toMatch(/superRefine/);
        expect(MODAL_SRC).toMatch(/applicability === ['"]NOT_APPLICABLE['"]/);
        expect(MODAL_SRC).toMatch(/justification/);
    });
});

// ─── 4. Legacy /controls/new → redirect shim ────────────────────

describe('/controls/new — redirect compat shim', () => {
    it('is no longer a client page — it is a server redirect', () => {
        expect(NEW_PAGE_SRC).not.toMatch(/^'use client'/m);
        expect(NEW_PAGE_SRC).toMatch(/from ['"]next\/navigation['"]/);
        expect(NEW_PAGE_SRC).toMatch(/redirect\(/);
    });

    it('redirects to /controls?create=1 for the current tenant', () => {
        expect(NEW_PAGE_SRC).toMatch(/\/controls\?create=1/);
    });

    it('awaits the async params promise per Next.js 15 convention', () => {
        expect(NEW_PAGE_SRC).toMatch(/params:\s*Promise<\{\s*tenantSlug:\s*string\s*\}>/);
        expect(NEW_PAGE_SRC).toMatch(/await params/);
    });
});

// ─── 5. ControlsClient wiring ────────────────────────────────────

describe('ControlsClient — create trigger + auto-open', () => {
    it('imports NewControlModal', () => {
        // Accept both static and dynamic imports (lazy-loading via next/dynamic)
        const hasImport = /from ['"]\.\/NewControlModal['"]/.test(CLIENT_SRC) ||
            /import\(['"]\.\/NewControlModal['"]\)/.test(CLIENT_SRC);
        expect(hasImport).toBe(true);
    });

    it('turned the #new-control-btn <Link> into a <button> that opens the modal', () => {
        expect(CLIENT_SRC).toMatch(/<button[\s\S]*?id=["']new-control-btn["'][\s\S]*?onClick=\{\(\)\s*=>\s*setIsCreateOpen\(true\)\}/);
        // Drift sentinel — the old Link-to-/new route must not come back.
        expect(CLIENT_SRC).not.toMatch(/href=\{tenantHref\(['"]\/controls\/new['"]\)\}/);
    });

    it('mounts <NewControlModal> with controlled state + tenantSlug', () => {
        expect(CLIENT_SRC).toMatch(/<NewControlModal\b/);
        expect(CLIENT_SRC).toMatch(/open=\{isCreateOpen\}/);
        expect(CLIENT_SRC).toMatch(/setOpen=\{setIsCreateOpen\}/);
        expect(CLIENT_SRC).toMatch(/tenantSlug=\{tenantSlug\}/);
    });

    it('auto-opens when the URL carries ?create=1 and strips the flag', () => {
        // Opens on `?create=1` and strips the flag — asserted as the CALL
        // to the shared hook, not its internals. The inline mechanism
        // (`searchParams?.get('create')`, `router.replace`,
        // `next.delete('create')`) moved into `useCreateQueryParam` on
        // 2026-08-05; asserting it here made extracting that seven-times
        // duplicated effect break five tests for no behavioural change.
        expect(CLIENT_SRC).toMatch(/useCreateQueryParam\(/);
    });
});
