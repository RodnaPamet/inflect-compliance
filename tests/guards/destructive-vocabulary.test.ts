/**
 * Roadmap-4 PR-9 — destructive-action vocabulary.
 *
 * Destructive flows in the product (delete a tenant, revoke an API
 * key, remove MFA, archive evidence) currently use a thoughtful
 * mix of verbs:
 *
 *   • Revoke API key   — invalidate a credential
 *   • Revoke SCIM token— invalidate a credential
 *   • Delete SSO conf  — permanent erasure of a configuration
 *   • Remove MFA       — deactivate (user can re-enroll later)
 *
 * The verbs map cleanly to intent — exactly the pattern Roadmap-2
 * PR-5 established for *constructive* actions (Create / Add /
 * Link). This ratchet locks the same discipline for destructive
 * actions so future PRs can't drift toward "Drop", "Clear",
 * "Cancel", or other verbs that read as ambiguous.
 *
 * Canonical destructive verbs
 *
 *   - **Delete**     — permanent erasure of a top-level entity or
 *                      configuration. The data is gone.
 *   - **Remove**     — detach an item from a parent, OR turn off
 *                      an enrollment. Source row may live on.
 *   - **Revoke**     — invalidate an authority / credential
 *                      (token, key, session, role grant).
 *   - **Discard**    — abandon unsaved or draft state.
 *   - **Archive**    — soft delete with history preserved.
 *   - **Unlink**     — break an association (cross-entity
 *                      traceability link, custom-role binding).
 *   - **Detach**     — like Unlink, used where "link" is also a
 *                      verb in the same surface (file detach,
 *                      vendor document detach).
 *   - **Reject**     — refuse a request (approval, finding).
 *   - **Reset**      — discard the current customised state and
 *                      restore a recommended/default baseline
 *                      (reset a drifted dashboard to its preset).
 *
 * What this ratchet locks
 *
 *   Every `<ConfirmDialog tone="danger">` callsite MUST have a
 *   `confirmLabel="<verb> …"` that begins with one of the
 *   canonical verbs above. The detector pairs the `tone="danger"`
 *   line with the nearest `confirmLabel=` on the same prop block
 *   so we don't false-positive on unrelated label strings
 *   elsewhere in the file.
 *
 * What this ratchet does NOT police
 *
 *   - Destructive `<Button>` labels outside a ConfirmDialog
 *     (inline Reject / Archive on rows). Those are already
 *     governed by the existing action-label vocabulary ratchet
 *     and the Epic 67 undo-toast convention; layering a third
 *     scan would duplicate without clarifying.
 *
 *   - Email / notification copy. Those use the verbs
 *     organically; out of scope.
 *
 *   - Title sentences (e.g. "Revoke API key?"). The verb is
 *     already in the confirmLabel — duplicating the assertion
 *     would catch nothing the confirmLabel check misses.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

// Catalog for confirmLabels migrated to next-intl. A `confirmLabel={t('key')}`
// is resolved against en.json using the file's `useTranslations('<ns>')`
// namespace, so the canonical-verb check runs on the rendered English.
const EN_MESSAGES = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf-8'),
) as Record<string, unknown>;
function resolveI18nLabel(fileSrc: string, key: string): string | null {
    const ns = fileSrc.match(/useTranslations\(\s*['"](\w+)['"]\s*\)/)?.[1];
    if (!ns) return null;
    const v = key
        .split('.')
        .reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            EN_MESSAGES[ns],
        );
    return typeof v === 'string' ? v : null;
}

// 2026-09-12 — AGENTIC UI 3/4 (#2454): 'Abort' joins the nine.
//
// Aborting an agent run is destructive and none of the others names it. It does
// not Delete or Remove a record, nothing is Archived, it is not an Unlink or a
// Detach, the run is not Rejected (that is the proposal queue's verb, and
// reusing it here would collide with a different act), and Discard would claim
// the work already done is thrown away when it is not — an aborted run keeps
// everything it completed. Reset means something else again.
//
// The point of this list is ONE vocabulary rather than a short one, so a tenth
// act that genuinely has no name among the nine earns a word rather than
// borrowing a wrong one. It is a stop, mid-flight, of something already running.
const CANONICAL_VERBS = [
    'Abort',
    'Delete',
    'Remove',
    'Revoke',
    'Discard',
    'Archive',
    'Unlink',
    'Detach',
    'Reject',
    'Reset',
];

// Match `confirmLabel="<verb> …"` (or `'<verb> …'`). Case-
// sensitive on the verb because the canonical form is title-
// case ("Delete" not "delete").
const VERB_OK = new RegExp(
    `^(${CANONICAL_VERBS.join('|')})\\b`,
);

interface Offence {
    file: string;
    line: number;
    label: string;
}

describe('Destructive-action vocabulary (Roadmap-4 PR-9)', () => {
    it('every ConfirmDialog tone="danger" carries a canonical confirmLabel verb', () => {
        const offenders: Offence[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name === 'node_modules' || e.name === '.next')
                        continue;
                    walk(full);
                    continue;
                }
                if (!/\.tsx$/.test(e.name)) continue;
                const rel = path.relative(ROOT, full);
                const fileSrc = fs.readFileSync(full, 'utf-8');
                const lines = fileSrc.split('\n');
                lines.forEach((line, i) => {
                    // Hunt the danger-tone marker. When we find
                    // one, scan a 12-line window after it for the
                    // sibling confirmLabel — typical ConfirmDialog
                    // prop blocks fit in a handful of lines.
                    if (!/tone\s*=\s*["']danger["']/.test(line)) return;
                    let labelLine: string | null = null;
                    let labelLineIdx = -1;
                    for (
                        let j = i;
                        j < Math.min(lines.length, i + 12);
                        j++
                    ) {
                        const m = lines[j].match(
                            /confirmLabel\s*=\s*["']([^"']+)["']/,
                        );
                        if (m) {
                            labelLine = m[1];
                            labelLineIdx = j;
                            break;
                        }
                        // confirmLabel={t('key')} / {tx('key')} — resolve the
                        // migrated key against the en catalog.
                        const mi = lines[j].match(
                            /confirmLabel\s*=\s*\{\s*t\w*\(\s*['"]([\w.]+)['"]\s*\)\s*\}/,
                        );
                        if (mi) {
                            const resolved = resolveI18nLabel(fileSrc, mi[1]);
                            if (resolved !== null) {
                                labelLine = resolved;
                                labelLineIdx = j;
                                break;
                            }
                        }
                    }
                    if (labelLine === null) {
                        offenders.push({
                            file: rel,
                            line: i + 1,
                            label: '<missing confirmLabel>',
                        });
                        return;
                    }
                    if (!VERB_OK.test(labelLine)) {
                        offenders.push({
                            file: rel,
                            line: labelLineIdx + 1,
                            label: labelLine,
                        });
                    }
                });
            }
        };
        walk(path.join(ROOT, 'src'));
        if (offenders.length > 0) {
            const lines = offenders
                .map((o) => `  ${o.file}:${o.line} — confirmLabel="${o.label}"`)
                .join('\n');
            throw new Error(
                `These ConfirmDialog destructive flows use a non-canonical verb. Use one of: ${CANONICAL_VERBS.join(', ')}.\n${lines}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});
