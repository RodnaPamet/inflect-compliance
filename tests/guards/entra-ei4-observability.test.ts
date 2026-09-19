/**
 * EI-4 ratchet — the Entra/SCIM operational-observability wiring + test
 * infrastructure must stay in place:
 *   - the group-claim resolver exists, records a metric, and logs;
 *   - the metrics module exports the Entra + SCIM recorders;
 *   - SCIM auth records an outcome at every terminal branch;
 *   - the shared Entra fixture library exists.
 *
 * A future "simplify" PR that strips the metric wiring (turning a silent Graph
 * outage or SCIM brute-force back into a dashboard blind spot) fails here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('EI-4 Entra/SCIM observability', () => {
    it('the group-claim resolver is extracted and observable', () => {
        expect(exists('src/lib/auth/entra-group-claims.ts')).toBe(true);
        const src = read('src/lib/auth/entra-group-claims.ts');
        expect(src).toMatch(/export async function resolveEntraGroupClaims/);
        expect(src).toMatch(/recordEntraGroupResolution/);
        expect(src).toMatch(/edgeLogger/);
    });

    it('the metrics module exports the Entra + SCIM recorders', () => {
        const metrics = read('src/lib/observability/metrics.ts');
        expect(metrics).toMatch(/export function recordEntraGroupResolution/);
        expect(metrics).toMatch(/export function recordScimAuth/);
        // The metric names operators dashboard on.
        expect(metrics).toMatch(/auth\.entra\.group_resolution/);
        expect(metrics).toMatch(/auth\.entra\.graph_fetch\.duration/);
        expect(metrics).toMatch(/scim\.auth\.count/);
    });

    it('SCIM auth records an outcome at every terminal branch', () => {
        const auth = read('src/lib/scim/auth.ts');
        expect(auth).toMatch(/recordScimAuth/);
        for (const reason of ['missing_header', 'empty_token', 'not_found', 'revoked', 'ok']) {
            expect(auth).toContain(`reason: '${reason}'`);
        }
    });

    it('the shared Entra fixture library exists', () => {
        expect(exists('tests/helpers/entra.ts')).toBe(true);
        const fixtures = read('tests/helpers/entra.ts');
        expect(fixtures).toMatch(/buildEntraProfile/);
        expect(fixtures).toMatch(/buildEntraOverageProfile/);
        expect(fixtures).toMatch(/graphMemberOfFetch/);
    });
});
