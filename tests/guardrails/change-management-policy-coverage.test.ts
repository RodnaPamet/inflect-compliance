/**
 * Structural ratchet — change-management policy doc.
 *
 * Keeps docs/change-management-policy.md structurally complete + honest:
 *   - the file exists,
 *   - all nine H2 sections are present (Scope through Open policy questions),
 *   - the approval matrix is a real (non-empty) markdown table,
 *   - it cross-links to its operational twin (deployment.md) + the on-call
 *     runbook (incident-response.md),
 *   - the "Open policy questions" section is non-empty (honesty guard — a
 *     change policy that claims every question is answered is a smell).
 *
 * See docs/change-management-policy.md.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const DOC = path.join(ROOT, 'docs/change-management-policy.md');
const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf-8') : '';

const REQUIRED_H2 = [
    '## Scope',
    '## Change classes',
    '## Approval matrix',
    '## Audit trail',
    '## Emergency change procedure',
    '## Rollback policy',
    '## What "production-affecting change" excludes',
    '## On-call coverage',
    '## Open policy questions',
];

/** Body of a `## <heading>` section up to the next H2 (or EOF). */
function section(heading: string): string {
    const re = new RegExp(`${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n([\\s\\S]*?)(?:\\n##\\s|$)`);
    return doc.match(re)?.[1] ?? '';
}

describe('change-management-policy doc', () => {
    it('exists', () => {
        expect(doc.length).toBeGreaterThan(0);
    });

    it('has all nine canonical H2 sections', () => {
        const missing = REQUIRED_H2.filter((h) => !doc.includes(`\n${h}\n`));
        expect(missing).toEqual([]);
    });

    it('the approval matrix is a non-empty markdown table', () => {
        const body = section('## Approval matrix');
        // A markdown table: a header separator row + at least one data row.
        expect(/\|\s*-+\s*\|/.test(body)).toBe(true);
        const dataRows = body
            .split('\n')
            .filter((l) => l.trim().startsWith('|') && !/^\|[\s|:-]+\|?$/.test(l.trim()));
        // header row + ≥3 change-type rows.
        expect(dataRows.length).toBeGreaterThanOrEqual(4);
    });

    it('cross-links to deployment.md and incident-response.md', () => {
        expect(doc).toMatch(/deployment\.md/);
        expect(doc).toMatch(/incident-response\.md/);
    });

    it('has a non-empty Open policy questions section (honesty guard)', () => {
        const body = section('## Open policy questions').trim();
        // At least three bullet questions.
        const bullets = body.match(/^- \*\*/gm) ?? [];
        expect(bullets.length).toBeGreaterThanOrEqual(3);
    });

    // ── THE DOC AND ITS GATE CANNOT DRIFT APART (#4437) ──────────────────
    //
    // The policy described a CI gate on SIGNIFICANT changes as an unbuildable
    // follow-up for months, on a reason that was true of file scanners and not
    // of a workflow step. The gate exists now, and the risk flips: the prose
    // could outlive it, or the gate could be deleted while the prose still
    // promises it. These three assertions pin them to each other.

    it('names the SIGNIFICANT gate it relies on, and that gate exists', () => {
        expect(doc).toMatch(/scripts\/check-significant-change-analysis\.mjs/);
        expect(fs.existsSync(path.join(ROOT, 'scripts/check-significant-change-analysis.mjs'))).toBe(true);
    });

    it('the gate is a real job in ci.yml, self-tested before it is trusted', () => {
        const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf-8');
        expect(ci).toMatch(/^ {2}change-class:$/m);
        // Its classifier decides whether any PR is gated at all, so a broken
        // one gates nothing silently. The self-test runs first, and blocking.
        expect(ci).toMatch(/check-significant-change-analysis\.mjs --self-test/);
        // It must still REPORT in the queue: a required check that does not run
        // under `merge_group` is ABSENT, and absence scores as zero failures.
        const job = /^ {2}change-class:$/m.exec(ci)?.index ?? -1;
        expect(job).toBeGreaterThan(-1);
        const block = ci.slice(job, job + 3000);
        expect(block).toMatch(/merge_group|pull_request/);
    });

    it('presents the gate as built, not as a follow-up', () => {
        // Tested as an ACTIVE CLAIM rather than as the absence of a phrase.
        // The first draft of this test forbade the old justification outright
        // and failed on the policy's own history note, which QUOTES it — the
        // quote is the useful part, so the assertion was wrong, not the doc.
        //
        // So: the doc must state the gate exists (positive), and must not
        // describe it as pending (the active claim). A paragraph explaining
        // what it used to say stays legal.
        expect(doc).toMatch(/fails it when a SIGNIFICANT change/);
        expect(doc).not.toMatch(/is a\s+documented follow-up/);
        expect(doc).not.toMatch(/intentionally not retrofitted/);
    });
});
