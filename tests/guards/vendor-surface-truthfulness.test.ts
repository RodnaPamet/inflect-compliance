/**
 * The vendor surface must not assert outcomes the server did not confirm.
 *
 * Every invariant here was violated in shipped code, and every violation
 * shared one shape: the UI reported success, emptiness, or completion
 * without having established any of them.
 *
 *   1. A thrown fetch cannot strand the page in `loading`.
 *   2. A failed load is not reported as "this vendor does not exist".
 *   3. A rejected write does not tear down the form as if it succeeded.
 *   4. A bulk action that fails is audible.
 *   5. Destructive actions are undoable (Epic 67).
 *   6. "Sent" is not claimed when the email never queued.
 *   7. The one-time link is not destroyed by an unguarded click.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const DETAIL = 'src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx';
const LIST = 'src/app/t/[tenantSlug]/(app)/vendors/VendorsClient.tsx';
const SHELL = 'src/components/layout/EntityDetailLayout.tsx';

describe('1 — a thrown fetch cannot strand the page in loading', () => {
    const src = read(DETAIL);

    it('fetchVendor clears loading in a finally block', () => {
        const fn = src.slice(
            src.indexOf('const fetchVendor'),
            src.indexOf('const fetchDocs'),
        );
        expect(fn).toMatch(/try \{/);
        expect(fn).toMatch(/\} finally \{[\s\S]*?setLoading\(false\)/);
    });
});

describe('2 — a failed load is distinguished from a missing vendor', () => {
    const src = read(DETAIL);

    it('tracks the two cases separately', () => {
        expect(src).toMatch(/loadError/);
        // 404 is genuinely "no such vendor"; anything else is a failure to
        // load one that may well exist.
        expect(src).toMatch(/res\.status === 404 \? 'missing' : 'failed'/);
    });

    it('offers a retry rather than a dead end', () => {
        expect(src).toMatch(/onRetry: fetchVendor/);
    });

    it('the shell supports a retry affordance', () => {
        const shell = read(SHELL);
        expect(shell).toMatch(/onRetry\?: \(\) => void/);
        expect(shell).toMatch(/data-testid="entity-detail-retry"/);
    });

    it('the plain-string error form still works', () => {
        // Most callers have nothing useful to retry — the extension must not
        // force every one of them to change.
        const shell = read(SHELL);
        expect(shell).toMatch(/error\?: string \|/);
        expect(shell).toMatch(/typeof error === 'string'/);
    });
});

describe('3 — a rejected write does not look like a success', () => {
    const src = read(DETAIL);

    it('the add-link mutation checks the response before closing the form', () => {
        // Was: await fetch(...); setShowLinkForm(false); … — a 400 or 403
        // cleared the form exactly like a success.
        const idx = src.indexOf('submit-link-btn');
        const block = src.slice(idx, idx + 1400);
        expect(block).toMatch(/const res = await fetch\(/);
        expect(block).toMatch(/if \(!res\.ok\)/);
    });
});

describe('4 — a failed bulk action is audible', () => {
    const src = read(LIST);

    it('does not throw a bare Error from the un-awaited handler', () => {
        // The throw landed in a try/finally with NO catch, so a 403 on a
        // 40-vendor bulk delete produced an unhandled rejection and a
        // stopped spinner.
        //
        // Comments stripped first: the fix documents the old line verbatim
        // to explain what was wrong, and that note is worth keeping.
        const code = src
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '');
        expect(code).not.toMatch(/throw new Error\('Bulk action failed'\)/);
    });

    it('has a catch and reports through toast', () => {
        const fn = src.slice(src.indexOf('const handleBulkApply'));
        expect(fn.slice(0, 1600)).toMatch(/\} catch \{/);
        expect(fn.slice(0, 1600)).toMatch(/toast\.error\(/);
    });

    it('the failure string is localised, not hardcoded English', () => {
        expect(src).toMatch(/t\('bulk\.failed'\)/);
    });
});

describe('5 — destructive vendor actions are undoable', () => {
    const src = read(DETAIL);

    it.each(['removeLink', 'removeSubprocessor', 'removeDoc'])(
        '%s goes through the undo toast',
        (fnName) => {
            const idx = src.indexOf(`const ${fnName} = (`);
            expect(idx).toBeGreaterThan(-1);
            const fn = src.slice(idx, idx + 1200);
            expect(fn).toMatch(/triggerUndoToast\(\{/);
            // Optimistic remove + restore on undo AND on failure.
            expect(fn).toMatch(/undoAction:/);
            expect(fn).toMatch(/onError:/);
        },
    );

    it('no bare DELETE remains on the link or subprocessor rows', () => {
        expect(src).not.toMatch(
            /await fetch\(apiUrl\(`\/vendors\/\$\{params\.vendorId\}\/links\/\$\{l\.id\}`\), \{ method: 'DELETE' \}\)/,
        );
    });
});

describe('6 — "sent" is not claimed when nothing was emailed', () => {
    const src = read(DETAIL);

    it('reads the notificationQueued flag rather than discarding it', () => {
        expect(src).toMatch(/notificationQueued\?: boolean/);
        expect(src).toMatch(/result\.notificationQueued === false/);
    });

    it('has distinct copy for the not-emailed case', () => {
        expect(src).toMatch(/detail\.sentNotEmailedToast/);
        expect(src).toMatch(/detail\.linkNotEmailedHint/);
    });

    it('applies to resend too — it can also collapse in the outbox dedupe', () => {
        const fn = src.slice(
            src.indexOf('const handleResend'),
            src.indexOf('const handleResend') + 1800,
        );
        expect(fn).toMatch(/notificationQueued === false/);
    });
});

describe('7 — the one-time link is not destroyed by an unguarded click', () => {
    const src = read(DETAIL);

    it('dismissing opens a confirm rather than clearing immediately', () => {
        expect(src).toMatch(/setConfirmDismissLink\(true\)/);
        expect(src).toMatch(/<ConfirmDialog/);
        expect(src).toMatch(/detail\.dismissLink\.title/);
    });

    it('states that the link cannot be shown again', () => {
        // Only the SHA-256 is stored; recovery means a resend, which rotates
        // the token and invalidates anything already shared.
        expect(src).toMatch(/detail\.linkOneTimeWarning/);
    });

    it('surfaces the expiry the send response returns', () => {
        expect(src).toMatch(/sendLinkExpiresAt/);
        expect(src).toMatch(/detail\.linkExpiresOn/);
    });
});
