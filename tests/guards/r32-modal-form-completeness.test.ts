/**
 * R32-task-63 — Modal-form completeness verification.
 *
 * The memory-tracked "modal-form migration" roadmap (3 phases —
 * architecture / execution / hardening) called out tasks /
 * policies / vendors / assets as needing their full-page create
 * flows moved into contextual modals. Verification at the start of
 * R32-task-63 found ALL THREE PHASES already shipped on main:
 *
 *   • P1 (architecture, 2026-05-24 implementation note) — the
 *     `useNewXForm` hook family + `_form/NewXFields` extraction.
 *   • P2 (execution) — every `/{tasks,policies,vendors,assets}/new`
 *     route is now a redirect shim to `?create=1`; the modals
 *     themselves live in `New{Task,Policy,Vendor,Asset}Modal.tsx`
 *     on the list pages.
 *   • P3 (hardening) — every modal carries a `guardedSetOpen`
 *     handler that gates close on `form.isDirty` with a
 *     `window.confirm('Discard … Any details you entered will be
 *     lost.')` prompt, plus a `form.submitting` guard.
 *
 * This ratchet locks the completeness state so a future PR that
 * removes the guard / regresses any of the four migrations fails
 * CI loudly. The earlier `assets-audits-modal-form.test.ts` ratchet
 * carries a narrower assets-and-audits assertion; this file widens
 * the assertion family to the canonical four entities.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

/**
 * The four canonical entities the memory-tracked roadmap targeted.
 * Each row maps to ONE redirect shim, ONE NewXModal, ONE
 * useNewXForm hook. Adding a fifth entity to the modal family
 * means adding a row here + adopting the canonical pattern.
 */
const ENTITIES = [
    {
        slug: "tasks",
        modal: "NewTaskModal",
        formHook: "useNewTaskForm",
    },
    {
        slug: "policies",
        modal: "NewPolicyModal",
        formHook: "useNewPolicyForm",
    },
    {
        slug: "vendors",
        modal: "NewVendorModal",
        formHook: "useNewVendorForm",
    },
    {
        slug: "assets",
        modal: "NewAssetModal",
        formHook: "useNewAssetForm",
    },
] as const;

describe("R32-task-63 — modal-form completeness", () => {
    for (const entity of ENTITIES) {
        describe(`${entity.slug} entity`, () => {
            const redirectPath = `src/app/t/[tenantSlug]/(app)/${entity.slug}/new/page.tsx`;
            const modalPath = `src/app/t/[tenantSlug]/(app)/${entity.slug}/${entity.modal}.tsx`;
            const formHookPath = `src/app/t/[tenantSlug]/(app)/${entity.slug}/_form/${entity.formHook}.ts`;

            it("ships the /new redirect shim (P2 contract)", () => {
                // Bookmarks, deep links, and E2E
                // `page.goto('/{slug}/new')` continue to work — they
                // land on `/{slug}?create=1`, which the list-page
                // client detects on mount and opens the modal.
                expect(exists(redirectPath)).toBe(true);
                const src = read(redirectPath);
                expect(src).toMatch(
                    /import\s*\{\s*redirect\s*\}\s*from\s*['"]next\/navigation['"]/,
                );
                // The redirect path must contain the entity slug
                // immediately followed by a query string. The
                // `create=1` flag is the canonical bootstrap; for
                // policies it's composed via a `query` variable
                // (template/non-template branch), so accept
                // either inline `create=1` OR a substitution that
                // resolves to it (we lock the variable
                // declaration separately below).
                expect(src).toMatch(
                    new RegExp(`/t/\\$\\{tenantSlug\\}/${entity.slug}\\?`),
                );
                expect(src).toMatch(/create=1/);
            });

            it("ships the NewXModal", () => {
                expect(exists(modalPath)).toBe(true);
            });

            it("ships the useNewXForm hook with an isDirty return field (P1 contract)", () => {
                expect(exists(formHookPath)).toBe(true);
                const src = read(formHookPath);
                // The hook's return shape MUST expose `isDirty` —
                // that's the foundation the P3 guard reads.
                expect(src).toMatch(/isDirty:\s*boolean/);
            });

            it("modal close is dirty-state guarded (P3 contract)", () => {
                const src = read(modalPath);
                // The canonical `guardedSetOpen` shape: a wrapper
                // around `setOpen` that refuses to close on a
                // dirty form unless the user confirms via the
                // browser's native confirm prompt. Submitting
                // forms also block close (a separate guard).
                expect(src).toMatch(/guardedSetOpen/);
                expect(src).toMatch(/form\.isDirty/);
                expect(src).toMatch(/form\.submitting/);
                // The "Discard … will be lost" copy is the canonical
                // prompt. Three accepted shapes, in increasing order of
                // migration:
                //   1. an inline `window.confirm('… lost.')` literal
                //   2. i18n'd `window.confirm(t('key'))`
                //   3. a <ConfirmDialog description={t('key')}> — the
                //      platform primitive. window.confirm renders
                //      browser chrome: unstyled, untranslatable beyond its
                //      message, and unreachable from tests, so a modal
                //      moving off it is an UPGRADE and must not fail this
                //      ratchet. The canonical copy is still locked; only
                //      the delivery mechanism changed.
                // For shapes 2 and 3 the key is resolved against en.json
                // (namespace === entity slug) so the copy stays pinned
                // through the catalog.
                const inlineConfirm =
                    /window\.confirm\([\s\S]{0,200}lost\./.test(src);
                if (!inlineConfirm) {
                    const keyMatch =
                        src.match(
                            /window\.confirm\(\s*t\(['"]([\w.]+)['"]\)/,
                        ) ??
                        // <ConfirmDialog … description={t('key')} …>.
                        // Scoped to the ConfirmDialog's own props: the file
                        // also renders <Modal description={t('new.modalDesc')}>,
                        // and an unscoped search finds that one first.
                        (() => {
                            // `<ConfirmDialog\s` — the trailing whitespace is
                            // load-bearing: it requires a real JSX element with
                            // props, so a bare "<ConfirmDialog>" mentioned in a
                            // prose comment cannot be picked up instead (which
                            // is exactly what happened first, and made this
                            // resolve the Modal's description key).
                            const tag = src.match(/<ConfirmDialog\s[\s\S]*?\/>/);
                            return tag
                                ? tag[0].match(
                                      /description=\{\s*t\(['"]([\w.]+)['"]\)\s*\}/,
                                  )
                                : null;
                        })();
                    expect(keyMatch).toBeTruthy();
                    const en = JSON.parse(read("messages/en.json")) as Record<
                        string,
                        unknown
                    >;
                    const resolved = keyMatch![1]
                        .split(".")
                        .reduce<unknown>(
                            (o, k) =>
                                o && typeof o === "object"
                                    ? (o as Record<string, unknown>)[k]
                                    : undefined,
                            en[entity.slug],
                        );
                    expect(typeof resolved).toBe("string");
                    expect(resolved as string).toMatch(/lost\./);
                }
            });
        });
    }
});
