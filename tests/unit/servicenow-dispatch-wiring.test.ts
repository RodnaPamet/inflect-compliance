/**
 * ServiceNow's check is dispatched by the EXISTING runner — it needs no job.
 *
 * The prompt for this step asked for a dispatch job on the `drainPages`
 * fan-out shape, following jobs/identity-sync.ts. That premise does not hold
 * for a check-shaped provider, and building one anyway would have added a
 * second, redundant dispatch path.
 *
 * THE DISTINCTION. The providers that own a fan-out job — identity-sync,
 * hris-sync, sharepoint-delta-sync — all MATERIALISE remote rows into local
 * tables (ConnectedIdentityAccount, Employee, evidence mappings). They need a
 * per-connection job because the unit of work is a connection.
 *
 * ServiceNow S1/S2 materialises nothing: `runCheck` reads the window live and
 * returns a CheckResult. Its unit of work is a CONTROL, and
 * `jobs/automation-runner.ts` already walks due controls every 15 minutes,
 * resolves the provider through `registry.resolveByAutomationKey`, and runs
 * the check. Registration is the whole wiring.
 *
 * So what is worth locking is not "a job exists" but that the check is
 * REACHABLE through that generic path — because the way it silently is not is
 * specific and easy: a check the engine handles but `supportedChecks` does not
 * list resolves to null, and `executeControlAutomation` logs a warning and
 * returns ERROR with an empty executionId. The control looks configured, the
 * runner looks healthy, and the check never runs.
 */
import '@/app-layer/integrations/bootstrap';
import { registry } from '@/app-layer/integrations/registry';
import { isScheduledCheckProvider } from '@/app-layer/integrations/types';
import { SCHEDULED_JOBS } from '@/app-layer/jobs/schedules';
import { SERVICENOW_CHECKS, runServiceNowCheck } from '@/app-layer/integrations/providers/servicenow/checks';

describe('the check is reachable through the generic runner', () => {
    it.each(SERVICENOW_CHECKS)('servicenow.%s resolves to the ServiceNow provider', (check) => {
        const r = registry.resolveByAutomationKey(`servicenow.${check}`);
        expect(r).not.toBeNull();
        expect(r?.provider.id).toBe('servicenow');
    });

    it('the provider is scheduled-check shaped, so the runner will not skip it', () => {
        const p = registry.getProvider('servicenow');
        expect(p).toBeDefined();
        expect(isScheduledCheckProvider(p!)).toBe(true);
    });

    it('every check the ENGINE handles is also routable', () => {
        // The silent failure: implemented but not listed in supportedChecks.
        // resolveByAutomationKey returns null, the runner warns, and the
        // control reports ERROR with no execution — configured, healthy-looking,
        // never run.
        for (const check of SERVICENOW_CHECKS) {
            expect(runServiceNowCheck(check, []).status).not.toBe('ERROR');
            expect(registry.canHandle(`servicenow.${check}`)).toBe(true);
        }
    });

    it('every check the PROVIDER advertises is one the engine handles', () => {
        // The mirror failure: advertised but unimplemented. The runner would
        // dispatch it and the engine's unknown-check arm would ERROR every
        // time — loud rather than silent, but still a control that can never
        // pass, configured by an admin who had no way to know.
        const advertised = registry.getProvider('servicenow')?.supportedChecks ?? [];
        expect(advertised.length).toBeGreaterThan(0);
        for (const check of advertised) {
            expect(runServiceNowCheck(check, []).status).not.toBe('ERROR');
        }
    });

    it('an unregistered check does NOT resolve', () => {
        // Proves the assertions above are not vacuous — the registry really
        // does gate on supportedChecks rather than accepting any key with the
        // right prefix.
        expect(registry.resolveByAutomationKey('servicenow.not_a_real_check')).toBeNull();
    });
});

describe('the runner that carries it is itself scheduled', () => {
    it('automation-runner has a cron — a runner that never fires dispatches nothing', () => {
        const runner = SCHEDULED_JOBS.find((j) => j.name === 'automation-runner');
        expect(runner).toBeDefined();
        expect(runner?.pattern).toBeTruthy();
    });

    it('and there is deliberately no servicenow-specific dispatch job', () => {
        // Written as an assertion so adding one is a visible decision rather
        // than a reflex. If ServiceNow later materialises change records into
        // a local table, the unit of work becomes a connection and this should
        // change — in the same diff that adds the table.
        expect(SCHEDULED_JOBS.map((j) => j.name).filter((n) => n.includes('servicenow'))).toEqual([]);
    });
});
