/**
 * Training / background check provider (PR-6) — INTERNAL provider that
 * evaluates training assignments + background checks. Queries scoped to
 * `input.tenantId` (automation-runner's raw-prisma + explicit-tenantId
 * pattern), then applies the pure `runTrainingCheck`.
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
import { runTrainingCheck, TRAINING_CHECKS, type CheckAssignment, type CheckBackgroundCheck } from './checks';

interface TrainingDeps {
    load?: (tenantId: string) => Promise<{ assignments: CheckAssignment[]; backgroundChecks: CheckBackgroundCheck[] }>;
    now?: () => Date;
}

export class TrainingProvider implements ScheduledCheckProvider {
    readonly id = 'training';
    // Internal provider over the tenant's own training rows — no credential.
    readonly liveValidation = false;
    readonly displayName = 'Training & Background';
    readonly description = 'Internal checks over security-awareness training completion and background-check status.';
    readonly supportedChecks = [...TRAINING_CHECKS];
    readonly configSchema: ConnectionConfigSchema = { configFields: [], secretFields: [] };

    private readonly deps: TrainingDeps;
    constructor(deps: TrainingDeps = {}) {
        this.deps = deps;
    }

    async validateConnection(): Promise<ConnectionValidationResult> {
        return { valid: true };
    }

    private async load(tenantId: string): Promise<{ assignments: CheckAssignment[]; backgroundChecks: CheckBackgroundCheck[] }> {
        if (this.deps.load) return this.deps.load(tenantId);
        const [assignments, backgroundChecks] = await Promise.all([
            prisma.trainingAssignment.findMany({
                where: { tenantId },
                select: { employeeId: true, status: true, dueAt: true, completedAt: true, employee: { select: { workEmail: true } }, course: { select: { cadenceDays: true } } },
                take: 10000,
            }),
            prisma.backgroundCheck.findMany({
                where: { tenantId },
                select: { employeeId: true, status: true, employee: { select: { workEmail: true } } },
                take: 10000,
            }),
        ]);
        return {
            assignments: assignments.map((a) => ({ employeeId: a.employeeId, employeeEmail: a.employee.workEmail, status: a.status, dueAt: a.dueAt, completedAt: a.completedAt, cadenceDays: a.course.cadenceDays })),
            backgroundChecks: backgroundChecks.map((b) => ({ employeeId: b.employeeId, employeeEmail: b.employee.workEmail, status: b.status })),
        };
    }

    async runCheck(input: CheckInput): Promise<CheckResult> {
        const start = Date.now();
        try {
            const data = await this.load(input.tenantId);
            const now = this.deps.now ? this.deps.now() : new Date();
            const result = runTrainingCheck(input.parsed.checkType, data, now);
            return { ...result, durationMs: Date.now() - start };
        } catch (err) {
            return { status: 'ERROR', summary: 'Training check failed to run.', details: {}, durationMs: Date.now() - start, errorMessage: err instanceof Error ? err.message : String(err) };
        }
    }

    mapResultToEvidence(input: CheckInput, result: CheckResult): EvidencePayload | null {
        if (result.status === 'ERROR') return null;
        return { title: `Training — ${input.parsed.checkType}`, content: result.summary, type: 'REPORT', category: `training:${input.parsed.checkType}` };
    }
}
