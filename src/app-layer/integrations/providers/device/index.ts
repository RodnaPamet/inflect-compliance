/**
 * Device check provider (PR-5) — INTERNAL provider that evaluates the device
 * inventory. Queries Device scoped to `input.tenantId` (automation-runner's
 * raw-prisma + explicit-tenantId pattern), then applies the pure
 * `runDeviceCheck`. A control with `automationKey:"device.devices_encrypted"`
 * flips PASSED/FAILED live.
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
import { runDeviceCheck, DEVICE_CHECKS, type CheckDevice } from './checks';

interface DeviceDeps {
    load?: (tenantId: string) => Promise<CheckDevice[]>;
    now?: () => Date;
}

export class DeviceProvider implements ScheduledCheckProvider {
    readonly id = 'device';
    // Internal provider over the tenant's own device rows — no credential.
    readonly liveValidation = false;
    readonly displayName = 'Device Posture';
    readonly description = 'Internal checks over the device inventory: disk encryption, screen lock, antivirus, password manager.';
    readonly supportedChecks = [...DEVICE_CHECKS];
    readonly configSchema: ConnectionConfigSchema = { configFields: [], secretFields: [] };

    private readonly deps: DeviceDeps;
    constructor(deps: DeviceDeps = {}) {
        this.deps = deps;
    }

    async validateConnection(): Promise<ConnectionValidationResult> {
        return { valid: true };
    }

    private async load(tenantId: string): Promise<CheckDevice[]> {
        if (this.deps.load) return this.deps.load(tenantId);
        return prisma.device.findMany({
            where: { tenantId },
            select: { serialNumber: true, hostname: true, platform: true, diskEncrypted: true, screenLockEnabled: true, antivirusRunning: true, passwordManagerPresent: true },
            take: 10000,
        });
    }

    async runCheck(input: CheckInput): Promise<CheckResult> {
        const start = Date.now();
        try {
            const devices = await this.load(input.tenantId);
            const now = this.deps.now ? this.deps.now() : new Date();
            const result = runDeviceCheck(input.parsed.checkType, devices, now);
            return { ...result, durationMs: Date.now() - start };
        } catch (err) {
            return { status: 'ERROR', summary: 'Device check failed to run.', details: {}, durationMs: Date.now() - start, errorMessage: err instanceof Error ? err.message : String(err) };
        }
    }

    mapResultToEvidence(input: CheckInput, result: CheckResult): EvidencePayload | null {
        if (result.status === 'ERROR') return null;
        return { title: `Device — ${input.parsed.checkType}`, content: result.summary, type: 'REPORT', category: `device:${input.parsed.checkType}` };
    }
}
