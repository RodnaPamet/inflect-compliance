/**
 * A column read on the hot path and written by nothing is not a switch.
 *
 * ── THE SHAPE OF THE DEFECT ─────────────────────────────────────────────────
 *
 * `TenantSecuritySettings.agentDriver` shipped with its reader
 * (`resolveDriverForTenant`, consulted on every agentic run), its enum, its
 * schema comment describing a two-key gate, and NO writer anywhere in `src/`.
 * Nothing was broken in a way a type or a test could see: the read worked, the
 * default was correct, the fail-closed behaviour was right. It was simply
 * impossible for any tenant to reach the other value through the product, so
 * the "customer's half of the gate" was a constant, and the only way to move
 * one was an UPDATE against production by hand — no authorization, no audit
 * row, no record of who decided it.
 *
 * This subsystem names that failure mode in its own comments — settable and
 * inert, gated and unsettable — which is why the guard is written as a
 * PROPERTY of the column rather than as an assertion about one function: the
 * next such column should fail here on the day it is added, not on the day
 * somebody tries to use it.
 *
 * ── WHAT IS ASSERTED ────────────────────────────────────────────────────────
 *
 * That the column has a write site at all; that the write site is a usecase
 * rather than a route or a job (so the audit row and the tenant context are
 * not a caller's responsibility); and that the surface which REPORTS the
 * setting reports the whole conjunction, because a switch that cannot say why
 * it did nothing is the same outage wearing a different label.
 */
import { readFileSync } from 'fs';
import path from 'path';

import { repoRelativeFiles } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

/**
 * `ROOT` computed LOCALLY — `tests/helpers/assertion-reach.ts` constant-folds a
 * `path.resolve(__dirname, …)` and declines an identifier imported from
 * another module, which would put every assertion here in the Class D
 * un-analysable set.
 */
const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(readFileSync(path.join(ROOT, rel), 'utf8'));

const USECASE = 'src/app-layer/usecases/agent-driver-setting.ts';

/**
 * Every `src/` file that names the column, as CODE — the schema's own comment
 * describes the two-key gate at length, and a scan that could not tell a
 * mention from a write would be satisfied by prose about the thing.
 */
const sites = repoRelativeFiles()
    .filter((f) => f.startsWith('src/') && (f.endsWith('.ts') || f.endsWith('.tsx')))
    .map((f) => ({ file: f, code: read(f) }))
    .filter((s) => s.code.includes('agentDriver'));

describe('the column can be written, and only through the seam that audits it', () => {
    it('is named by more than one file — a reader alone is the defect', () => {
        // The population assertion, and it is not decoration: every claim
        // below is satisfied by an empty scan, and an empty scan is exactly
        // what a renamed column would produce.
        expect(sites.length).toBeGreaterThanOrEqual(2);
    });

    it('has a WRITE site, not only reads', () => {
        const writers = sites.filter(
            (s) => s.code.includes('agentDriver: next') || s.code.includes('agentDriver:') && s.file === USECASE,
        );
        expect(writers.map((w) => w.file)).toContain(USECASE);
    });

    it('and the write lives in a usecase, not in a route or a job', () => {
        // Where the write lives decides what comes with it. In a usecase the
        // tenant context and the audit row are the function's own business; in
        // a route they are each caller's, and the second caller is where that
        // stops being true.
        const writeSites = sites
            .filter((s) => /agentDriver:\s*(next|'FLUE'|'STATIC'|mode)/.test(s.code))
            .map((s) => s.file);
        expect(writeSites).toEqual([USECASE]);
    });

    it('the write is upserted, so a tenant with no settings row can be enabled', () => {
        // The tenants nobody has configured anything for are exactly the ones
        // with no `TenantSecuritySettings` row — and exactly the ones a first
        // enablement is aimed at. An `update` alone throws P2025 on them.
        expect(read(USECASE)).toContain('tenantSecuritySettings.upsert(');
    });

    it('and it writes an audit row naming the change', () => {
        expect(read(USECASE)).toContain("action: 'AGENT_DRIVER_MODE_CHANGED'");
    });
});

describe('the surface reports the whole gate, not just its own half', () => {
    const usecase = read(USECASE);

    it('resolves the effective driver with the function the RUN path uses', () => {
        // Not a re-derived AND. A second copy of the conjunction is how a
        // settings page ends up reporting a capability the runtime refuses —
        // the identity write-policy route's `honoured` block exists for the
        // same reason and cost a real incident to learn.
        expect(usecase).toContain('resolveAgentDriver({ envEnabled, tenantSetting: mode })');
    });

    it('reads the operator switch and the build flag rather than restating them', () => {
        expect(usecase).toContain('flueEnvEnabled(env.AGENT_DRIVER_FLUE)');
        expect(usecase).toContain('DRIVER_IMPLEMENTED.flue');
    });

    it('coerces a stored value the same way the run path does', () => {
        // Any other reading here would make this surface disagree with the run
        // path about the same stored byte.
        expect(usecase).toContain('coerceStoredDriverMode(');
    });
});
