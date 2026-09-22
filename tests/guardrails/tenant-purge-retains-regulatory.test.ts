/**
 * The tenant purge must not destroy a regulatory artefact (#2747).
 *
 * The purge's default is DELETE: anything tenant-scoped and not explicitly
 * retained is removed. That default is right — it is what fixes the reported
 * bug, where "deleted" tenants kept 768 controls forever — but it means a new
 * model classed as a regulatory record is destroyed the moment it is added,
 * silently, by a job nobody is watching.
 *
 * So the retained set is checked against `docs/data-retention.md`, which is
 * where the classification decision actually lives. Two-sided: a regulatory
 * model missing from the set fails, AND a retained model the doc does not
 * class as regulatory fails, because an exemption nobody can justify is how
 * the purge quietly stops purging.
 *
 * This guard earned its place before it shipped: the first hand-written set
 * had 8 entries and the doc names 17 tenant-scoped ones.
 */
import * as fs from 'fs';
import * as path from 'path';

import { TENANT_PURGE_RETAINED } from '@/app-layer/usecases/tenant-purge';

const ROOT = path.resolve(__dirname, '../..');

/** Models the retention doc classes as a regulatory artefact. */
function regulatoryModels(): string[] {
    const doc = fs.readFileSync(path.join(ROOT, 'docs/data-retention.md'), 'utf-8');
    return [...new Set(
        [...doc.matchAll(/^\|\s*`([A-Za-z]+)`\s*\|\s*Regulatory artefact/gm)].map((m) => m[1]),
    )];
}

/** Of those, the ones the purge could actually reach — they carry a tenantId. */
function tenantScopedRegulatoryModels(): string[] {
    const dir = path.join(ROOT, 'prisma/schema');
    const schema = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.prisma'))
        .map((f) => fs.readFileSync(path.join(dir, f), 'utf-8'))
        .join('\n');
    return regulatoryModels().filter((m) => {
        const block = new RegExp(`\\nmodel ${m} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
        return Boolean(block && /^\s*tenantId\s/m.test(block[1]));
    });
}

describe('tenant purge — regulatory artefacts survive', () => {
    it('retains every tenant-scoped model the retention doc calls regulatory', () => {
        const missing = tenantScopedRegulatoryModels().filter((m) => !TENANT_PURGE_RETAINED.has(m));
        expect(missing).toEqual([]);
    });

    it('retains nothing the doc does not justify — except the Tenant tombstone', () => {
        // Two-sided. A stale exemption protects nothing and hides the next
        // real one, and here it would also mean a tenant is never fully
        // emptied — the bug coming back one model at a time.
        const justified = new Set([...tenantScopedRegulatoryModels(), 'Tenant']);
        const unjustified = [...TENANT_PURGE_RETAINED].filter((m) => !justified.has(m));
        expect(unjustified).toEqual([]);
    });

    it('keeps the Tenant tombstone, which is what makes the rest legal', () => {
        expect(TENANT_PURGE_RETAINED.has('Tenant')).toBe(true);
    });

    it('the doc is actually being read — a parse returning nothing must fail', () => {
        // Positive control. If the table format changes, both assertions above
        // pass vacuously on an empty list and this guard silently stops working.
        expect(regulatoryModels().length).toBeGreaterThan(10);
        expect(tenantScopedRegulatoryModels()).toContain('AuditLog');
    });

    it('does NOT retain ordinary business data', () => {
        for (const m of ['Control', 'Risk', 'Policy', 'Evidence', 'Employee']) {
            expect(TENANT_PURGE_RETAINED.has(m)).toBe(false);
        }
    });
});
