/**
 * Epic 55 Prompt 5 — shared <UserCombobox> + people-picker migrations.
 *
 * Asserts:
 *   1. The <UserCombobox> wrapper fetches members through a single
 *      tenant-scoped SWR key (the resolved `/users/assignable` URL),
 *      projects them into Combobox options, and exposes a narrow
 *      single-vs-multi API. (Per-tenant cache isolation comes from the
 *      tenantSlug in that URL.)
 *   2. Free-text UUID inputs are gone — replaced by UserCombobox:
 *        a. NewTaskPage          (#task-assignee-input)
 *        b. TaskDetailPage       (#task-assignee-input)
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../');
function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

const USER_COMBO_SRC = read('src/components/ui/user-combobox.tsx');
// Modal-form P1 (2026-05-24) — `tasks/new/page.tsx` was decomposed
// into page wrapper + `_form/useNewTaskForm.ts` + `_form/NewTaskFields.tsx`.
// Modal-form P2 (2026-05-24) — `tasks/new/page.tsx` further became
// a redirect shim → `/tasks?create=1`; the modal wrapper
// `NewTaskModal.tsx` now consumes the hook + fields. The Epic 55
// assertions don't care WHICH file carries an import / id / handler;
// they just lock the migration shape. Concatenate every related file.
const TASK_NEW_SRC =
    read('src/app/t/[tenantSlug]/(app)/tasks/new/page.tsx') +
    '\n' +
    read('src/app/t/[tenantSlug]/(app)/tasks/NewTaskModal.tsx') +
    '\n' +
    read('src/app/t/[tenantSlug]/(app)/tasks/_form/NewTaskFields.tsx') +
    '\n' +
    read('src/app/t/[tenantSlug]/(app)/tasks/_form/useNewTaskForm.ts');
const TASK_DETAIL_SRC = read(
    'src/app/t/[tenantSlug]/(app)/tasks/[taskId]/page.tsx',
);

// ─── 1. UserCombobox contract ───────────────────────────────────

describe('UserCombobox — contract', () => {
    it('is a client component', () => {
        expect(USER_COMBO_SRC).toMatch(/^"use client"/);
    });

    it('composes the shared <Combobox>', () => {
        expect(USER_COMBO_SRC).toMatch(
            /from ["']\.\/combobox["']/,
        );
        expect(USER_COMBO_SRC).toMatch(/<Combobox\b/);
    });

    it('fetches members via SWR, keyed on the tenant-scoped URL', () => {
        // SWR migration Wave 5a — was React Query (useQuery +
        // queryKeys.members.list); now raw useSWR keyed by the resolved
        // `/users/assignable` URL (tenant slug in the path → per-tenant cache).
        expect(USER_COMBO_SRC).toMatch(/useSWR</);
        expect(USER_COMBO_SRC).not.toMatch(/useQuery</);
        // B1 — the assignment picker reads from the non-admin
        // `/users/assignable` endpoint so EDITOR / READER users see
        // the roster. The legacy `/admin/members` URL is no longer
        // the assignment-picker path.
        expect(USER_COMBO_SRC).toMatch(
            /`\/api\/t\/\$\{tenantSlug\}\/users\/assignable`/,
        );
    });

    it('uses the non-admin assignable endpoint (B1 task-assignee fix)', () => {
        // Pre-B1 the picker fetched `/admin/members`, which is
        // admin-gated; non-admins saw an empty dropdown. The new
        // `/users/assignable` endpoint is gated by `assertCanRead`
        // and returns ACTIVE members only — no client-side status
        // filter is needed because the server already filters.
        expect(USER_COMBO_SRC).toMatch(/\/users\/assignable/);
    });

    it('falls back to an empty list when the fetch returns non-ok (no throw)', () => {
        expect(USER_COMBO_SRC).toMatch(/if \(!res\.ok\)[\s\S]{0,500}return \[\]/);
    });

    it('honours a `preloadedMembers` prop to skip the fetch', () => {
        expect(USER_COMBO_SRC).toMatch(/preloadedMembers\?:\s*Member\[\]/);
        expect(USER_COMBO_SRC).toMatch(
            /enabled:\s*!preloadedMembers/,
        );
    });

    it('honours an optional client-side `filter` prop', () => {
        expect(USER_COMBO_SRC).toMatch(
            /filter\?:\s*\(member:\s*Member\)\s*=>\s*boolean/,
        );
    });

    it('exposes single-select and multi-select prop unions', () => {
        expect(USER_COMBO_SRC).toMatch(/type SingleProps/);
        expect(USER_COMBO_SRC).toMatch(/type MultipleProps/);
        expect(USER_COMBO_SRC).toMatch(
            /UserComboboxProps\s*=\s*SingleProps\s*\|\s*MultipleProps/,
        );
    });

    it('single-select onChange emits (userId, member) with null when cleared', () => {
        expect(USER_COMBO_SRC).toMatch(
            /onChange:\s*\(userId:\s*string\s*\|\s*null,\s*member:\s*Member\s*\|\s*null\)/,
        );
    });

    it('multi-select onChange emits (userIds[], members[])', () => {
        expect(USER_COMBO_SRC).toMatch(
            /onChange:\s*\(userIds:\s*string\[\],\s*members:\s*Member\[\]\)/,
        );
    });

    it('defaults forceDropdown=true so modal/sheet contexts work', () => {
        expect(USER_COMBO_SRC).toMatch(/forceDropdown\s*=\s*true/);
    });

    it('projects members into "Name · email" labels for fuzzy search', () => {
        expect(USER_COMBO_SRC).toMatch(/memberLabel/);
        // Either `${member.email}` (legacy) or `${email}` (current — local
        // var so the null-fallback chain can reuse it) is acceptable; the
        // contract is the literal "name · email" template, not the source
        // of the email expression.
        expect(USER_COMBO_SRC).toMatch(
            /`\$\{name\}\s*·\s*\$\{(member\.)?email\}`/,
        );
    });

    it('exports useTenantMembers hook + Member type for call-site composition', () => {
        expect(USER_COMBO_SRC).toMatch(
            /export\s+function\s+useTenantMembers/,
        );
        expect(USER_COMBO_SRC).toMatch(/export\s+interface\s+Member/);
    });

    // Render-layer safety net: even if the PII middleware isn't
    // running on the read path (observed on prod 2026-04-29), the
    // dropdown must NEVER show raw `v1:`/`v2:` envelope text as if it
    // were a name or email. The structural assertion locks in the
    // ciphertext-detection helper so a future refactor can't quietly
    // drop it.
    it('treats v1:/v2: envelopes as unreadable (never renders ciphertext)', () => {
        expect(USER_COMBO_SRC).toMatch(/isCiphertextEnvelope/);
        expect(USER_COMBO_SRC).toMatch(
            /value\.startsWith\(['"]v1:['"]\)\s*\|\|\s*value\.startsWith\(['"]v2:['"]\)/,
        );
        // The fallback path produces a stable opaque handle so the
        // row is still distinguishable.
        expect(USER_COMBO_SRC).toMatch(/`User \$\{member\.id\.slice\(0,\s*8\)\}`/);
    });
});

// ─── 4. NewTaskPage — assignee picker migration ─────────────────

describe('NewTaskPage — assignee UserCombobox', () => {
    it('imports UserCombobox', () => {
        expect(TASK_NEW_SRC).toMatch(
            /from ["']@\/components\/ui\/user-combobox["']/,
        );
    });

    it('drops the legacy free-text <input id="task-assignee-input">', () => {
        expect(TASK_NEW_SRC).not.toMatch(
            /<input[^>]*\bid=["']task-assignee-input["']/,
        );
    });

    it('UserCombobox preserves id="task-assignee-input"', () => {
        expect(TASK_NEW_SRC).toMatch(
            /<UserCombobox[\s\S]{0,300}id=["']task-assignee-input["']/,
        );
    });

    it('pulls tenantSlug from useTenantContext', () => {
        expect(TASK_NEW_SRC).toMatch(
            /useTenantContext/,
        );
        expect(TASK_NEW_SRC).toMatch(
            /const\s*\{\s*tenantSlug\s*\}\s*=\s*useTenantContext\(\)/,
        );
    });

    it('writes selected userId into form.assigneeUserId (null → empty string)', () => {
        // Modal-form P1 — the legacy `update(...)` reducer call was
        // generalised to the shared form-hook's `setField(...)`
        // method. The semantic — `userId ?? ''` coercion on the
        // assigneeUserId field — is what matters; either name is OK.
        expect(TASK_NEW_SRC).toMatch(
            /(?:update|setField)\(['"]assigneeUserId['"],\s*userId\s*\?\?\s*['"]['"]\)/,
        );
    });
});

// ─── 5. TaskDetailPage — inline assign picker ───────────────────

describe('TaskDetailPage — inline assign UserCombobox', () => {
    it('imports UserCombobox', () => {
        expect(TASK_DETAIL_SRC).toMatch(
            /from ["']@\/components\/ui\/user-combobox["']/,
        );
    });

    it('pulls tenantSlug from useTenantContext', () => {
        expect(TASK_DETAIL_SRC).toMatch(
            /useTenantContext/,
        );
        expect(TASK_DETAIL_SRC).toMatch(/tenantSlug/);
    });

    it('drops the legacy "User ID" placeholder free-text input', () => {
        expect(TASK_DETAIL_SRC).not.toMatch(
            /<input[^>]*\bid=["']task-assignee-input["']/,
        );
        // And the placeholder string disappears with the input.
        expect(TASK_DETAIL_SRC).not.toMatch(
            /placeholder=["']User ID["']/,
        );
    });

    it('UserCombobox preserves id="task-assignee-input"', () => {
        expect(TASK_DETAIL_SRC).toMatch(
            /<UserCombobox[\s\S]{0,300}id=["']task-assignee-input["']/,
        );
    });

    it('wires the picker onChange into the assignee-draft state', () => {
        // #102 item 5 — the page migrated to useTenantSWR; the
        // assignee picker now writes a three-state draft
        // (`setAssigneeDraft`) instead of the old `setAssigneeInput`.
        expect(TASK_DETAIL_SRC).toMatch(
            /onChange=\{\(userId\)\s*=>\s*[\s\S]{0,80}setAssigneeDraft\(userId\s*\?\?\s*null\)/,
        );
    });

    it('preserves the existing #assign-task-btn save button', () => {
        expect(TASK_DETAIL_SRC).toMatch(/id=["']assign-task-btn["']/);
    });
});

// ─── 6. Drift sentinel — no regression in payload contract ──────

describe('Epic 55 Prompt 5 — payload contracts preserved', () => {
    it('TaskDetailPage still PATCHes assigneeUserId via /assign endpoint', () => {
        // #102 item 5 — the picker's effective value reaches the /assign
        // endpoint as an `assigneeUserId` payload.
        //
        // B3-4 note: this used to pin `assigneeUserId = assigneeValue ||
        // null`, a LOCAL VARIABLE that the `useTenantMutation` migration
        // dissolved — the same value now flows straight into
        // `assignMutation.trigger(...)` and is named by the mutation's
        // parameter instead. The contract this sentinel is named for is
        // the WIRE payload and the endpoint, so it asserts those; the
        // variable's spelling was never the thing worth protecting.
        // The round trip itself is executed in
        // `tests/rendered/task-detail-mutation-failures.test.tsx`.
        expect(TASK_DETAIL_SRC).toMatch(
            /JSON\.stringify\(\{\s*assigneeUserId\s*\}\)/,
        );
        expect(TASK_DETAIL_SRC).toMatch(/\/tasks\/\$\{taskId\}\/assign/);
    });

    it('NewTaskPage still carries assigneeUserId in form state', () => {
        expect(TASK_NEW_SRC).toMatch(/assigneeUserId/);
    });
});
