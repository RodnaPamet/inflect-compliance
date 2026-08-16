/**
 * Personnel check provider (PR-4) — an INTERNAL provider that evaluates the
 * roster against connected identity accounts. Unlike external providers it
 * reads tenant data: it queries Employee + ConnectedIdentityAccount scoped to
 * `input.tenantId` (the automation-runner's own raw-prisma + explicit-tenantId
 * pattern), then applies the pure `runPersonnelCheck`.
 *
 * A control with `automationKey:"personnel.offboarded_access_removed"` +
 * `evidenceSource:'INTEGRATION'` flips PASSED/FAILED from live data.
 */
import { prisma } from '@/lib/prisma';
import type {
    ScheduledCheckProvider,
    ConnectionConfigSchema,
    ConnectionValidationResult,
    CheckInput,
    CheckResult,
    EvidencePayload,
} from '../../types';
import { runPersonnelCheck, PERSONNEL_CHECKS, type CheckEmployee, type CheckAccount } from './checks';

interface PersonnelDeps {
    /** Injectable data loader for tests (defaults to a tenant-scoped prisma read). */
    load?: (tenantId: string) => Promise<{ employees: CheckEmployee[]; accounts: CheckAccount[] }>;
    now?: () => Date;
}

export class PersonnelProvider implements ScheduledCheckProvider {
    readonly id = 'personnel';
    // No external credential exists to probe: this provider reads the tenant's
    // own Employee / account rows. `validateConnection` returns valid
    // unconditionally, which is honest only because there is nothing to check.
    readonly liveValidation = false;
    readonly displayName = 'Personnel';
    readonly description = 'Internal checks over the personnel roster: offboarded access, onboarding SLA, manager coverage.';
    readonly supportedChecks = [...PERSONNEL_CHECKS];
    readonly configSchema: ConnectionConfigSchema = { configFields: [], secretFields: [] };

    private readonly deps: PersonnelDeps;
    constructor(deps: PersonnelDeps = {}) {
        this.deps = deps;
    }

    // Internal provider — no external connection to validate.
    async validateConnection(): Promise<ConnectionValidationResult> {
        return { valid: true };
    }

    private async load(tenantId: string): Promise<{ employees: CheckEmployee[]; accounts: CheckAccount[] }> {
        if (this.deps.load) return this.deps.load(tenantId);
        const [employees, accounts] = await Promise.all([
            prisma.employee.findMany({ where: { tenantId }, select: { workEmail: true, status: true, managerEmployeeId: true, startDate: true }, take: 10000 }),
            prisma.connectedIdentityAccount.findMany({ where: { tenantId }, select: { email: true, status: true, provider: true }, take: 10000 }),
        ]);
        return { employees, accounts };
    }

    async runCheck(input: CheckInput): Promise<CheckResult> {
        const start = Date.now();
        try {
            const data = await this.load(input.tenantId);
            const now = this.deps.now ? this.deps.now() : new Date();
            const result = runPersonnelCheck(input.parsed.checkType, data, input.connectionConfig, now);
            return { ...result, durationMs: Date.now() - start };
        } catch (err) {
            return { status: 'ERROR', summary: 'Personnel check failed to run.', details: {}, durationMs: Date.now() - start, errorMessage: err instanceof Error ? err.message : String(err) };
        }
    }

    mapResultToEvidence(input: CheckInput, result: CheckResult): EvidencePayload | null {
        if (result.status === 'ERROR') return null;
        return { title: `Personnel — ${input.parsed.checkType}`, content: result.summary, type: 'REPORT', category: `personnel:${input.parsed.checkType}` };
    }
}
