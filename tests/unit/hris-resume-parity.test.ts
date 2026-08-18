/**
 * HRIS gets identity-sync's resumable branch, and the reconcile that has to
 * come with it.
 *
 * BEFORE: a roster past MAX_EMPLOYEES (10,000) was `status: 'ERROR',
 * noRetry: true` — PERMANENT. For any customer large enough to exceed the cap
 * the provider could never succeed, on any run, ever. That is precisely the
 * customer a Workday connector is built for, so it would have shipped working
 * in testing and failing forever at the first real tenant.
 *
 * identity-sync solved this (H3-2) with two branches: resumable → treat
 * truncation as progress; not resumable → loud and non-retryable. HRIS only
 * ever had the second.
 *
 * THE HALF THAT IS EASY TO MISS: adding resume without changing the departure
 * reconcile INTRODUCES a wrongful-mass-termination bug. The old reconcile was
 * `workEmail: { notIn: seenEmails }`, correct only while a pass was one run.
 * Under resume `roster` is just the LAST slice, so notIn would terminate
 * everyone upserted by every earlier run of the same pass. identity-sync's own
 * comment names this: it "would have been introduced BY the resume feature".
 * Both halves are asserted here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const codeOnly = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const HRIS = 'src/app-layer/usecases/hris-sync.ts';
const IDENTITY = 'src/app-layer/usecases/identity-sync.ts';
const PROVIDER = 'src/app-layer/integrations/providers/hris/index.ts';

describe('the provider contract can express a resumable truncation', () => {
    it('ListEmployeesResult carries a resumeToken', () => {
        expect(codeOnly(read(PROVIDER))).toMatch(/resumeToken\?:\s*string\s*\|\s*null/);
    });

    it('listEmployees accepts the cursor to continue from', () => {
        // Without the parameter the token can be returned but never handed
        // back, which is a resume feature that never resumes.
        expect(codeOnly(read(PROVIDER))).toMatch(/listEmployees\([\s\S]{0,160}resumeFrom\?:\s*string\s*\|\s*null/);
    });
});

describe('a truncated roster splits on whether it can resume', () => {
    const src = codeOnly(read(HRIS));

    it('stores the cursor and the pass start when a token comes back', () => {
        expect(src).toMatch(/if\s*\(resumeToken\)/);
        expect(src).toMatch(/syncCursor:\s*resumeToken/);
        expect(src).toMatch(/syncPassStartedAt:\s*passStartedAt/);
    });

    it('reports PARTIAL rather than ERROR on that branch', () => {
        // The whole point: a large roster working as designed must not page
        // someone every night.
        expect(src).toMatch(/status:\s*'PARTIAL'/);
    });

    it('keeps the non-resumable branch loud and non-retryable', () => {
        // Unchanged behaviour for providers that genuinely cannot resume —
        // re-reading truncates at the same place, so three retries buy nothing.
        expect(src).toMatch(/noRetry:\s*true/);
    });

    it('reports zero departures on a partial pass', () => {
        // A partial pass has not seen the whole roster, so it cannot conclude
        // anybody left.
        expect(src).toMatch(/departed:\s*0/);
    });

    it('derives passStartedAt from the connection, not from now', () => {
        // Taking `now` would restart the pass clock on every run, so the
        // reconcile below would never see anything older than the current run
        // and would terminate nobody — a silent no-op reconcile.
        expect(src).toMatch(/passStartedAt\s*=\s*conn\.syncPassStartedAt\s*\?\?\s*now/);
    });
});

describe('the departure reconcile survives a multi-run pass', () => {
    const src = codeOnly(read(HRIS));

    it('compares syncedAt against the pass start', () => {
        expect(src).toMatch(/syncedAt:\s*\{\s*lt:\s*passStartedAt\s*\}/);
    });

    it('no longer reconciles against the last slice of the roster', () => {
        // THE bug resume would have introduced. `notIn: seenEmails` under
        // resume terminates everyone from earlier runs of the same pass.
        expect(src).not.toMatch(/workEmail:\s*\{\s*notIn/);
        expect(src).not.toMatch(/seenEmails/);
    });

    it('clears the cursor once the pass completes', () => {
        // Left set, the next run resumes a pass that already reconciled.
        expect(src).toMatch(/syncCursor:\s*null/);
        expect(src).toMatch(/syncPassStartedAt:\s*null/);
    });

    it('still refuses to reconcile on an empty roster', () => {
        // Pre-existing guard, and resume must not have quietly dropped it: an
        // empty-but-complete response (an API glitch) would otherwise
        // terminate the entire workforce.
        expect(src).toMatch(/roster\.length\s*>\s*0/);
    });

    it('matches the identity twin it was modelled on', () => {
        // If these two ever diverge again, one of them is wrong — that
        // divergence is what this whole change closes.
        expect(codeOnly(read(IDENTITY))).toMatch(/syncedAt:\s*\{\s*lt:\s*passStartedAt\s*\}/);
    });
});
