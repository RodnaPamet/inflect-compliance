/**
 * 5.6c / 5.6f (#3998, #4001): Tier C cannot be made editable, and the page's
 * citation of the check that holds it cannot go stale.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY AN EDITABLE TIER C WOULD BE THE WORST KIND OF FAILURE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * #3998 states it: phase 5 requires every committed policy to set
 * `enforcement: enforce` and landlock `hard_requirement`, checked mechanically
 * in CI. A UI that can flip either "turns that check into a statement about a
 * file rather than about the running system: the gate keeps passing while the
 * property it guarantees is gone."
 *
 * That is a guard that cannot express the failure it exists to catch — green
 * forever, about the wrong subject. So this asserts the UI side, and
 * #4001 asks for it to be mutation-proved by name rather than by passing.
 *
 * @module guards/sandbox-runtime-tier-c-stays-read-only
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { ENFORCEMENT_SETTINGS, REPORTING_CHANNELS } from '@/lib/sandbox-runtime/declarations';
import {
    TIER_C_CI_CHECK,
    TIER_C_POLICY_MODULE,
    displayForChannel,
    displayForEnforcement,
    displayForExecutionSwitch,
} from '@/app/t/[tenantSlug]/(app)/admin/sandbox-runtime/sandbox-runtime-display';

import { REPO_ROOT } from '../helpers/repo-files';

const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const DECLARED = {
    configured: true,
    configDigest: 'sha256:x',
    appliedAt: null,
    reachableVersion: '0.1.6',
    channels: {
        'anonymous-telemetry': null,
        'otlp-traces': null,
        'ocsf-file': null,
        'ocsf-over-otlp': null,
    },
} as const;

describe('Tier C never becomes editable', () => {
    it('both enforcement settings render non-actionable', () => {
        // Denominator first: TWO settings, named. An emptied list would satisfy
        // a loop over it while asserting nothing.
        expect(ENFORCEMENT_SETTINGS.map((s) => s.key)).toEqual([
            'enforcement',
            'landlock-compatibility',
        ]);
        for (const _setting of ENFORCEMENT_SETTINGS) {
            expect(displayForEnforcement().actionable).toBe(false);
        }
    });

    it('NO row on this page is actionable, in any state', () => {
        /*
            Wider than Tier C on purpose. The owner ruling of 2026-10-25 is that
            nothing on this page is flippable, and the narrower assertion would
            let a channel or the execution switch become actionable while this
            stayed green — the failure mode is a control that looks instant and
            needs a redeploy, wherever it appears.

            Every state of every row, so no branch is unexercised: an earlier
            version of `displayForExecutionSwitch` returned `actionable: true`
            from a branch nothing reached, and the name lied precisely because
            it was never exercised.
        */
        const rows = [
            ...REPORTING_CHANNELS.map((c) => displayForChannel(c.key, DECLARED)),
            ...REPORTING_CHANNELS.map((c) =>
                displayForChannel(c.key, { ...DECLARED, configured: false }),
            ),
            ...REPORTING_CHANNELS.map((c) =>
                displayForChannel(c.key, { ...DECLARED, reachableVersion: null }),
            ),
            displayForEnforcement(),
            displayForExecutionSwitch(false, false),
            displayForExecutionSwitch(true, false),
            displayForExecutionSwitch(false, true),
            displayForExecutionSwitch(true, true),
        ];
        // Denominator printed beside the assertion: 4 channels x 3 states, plus
        // enforcement, plus the switch's four.
        expect(rows.length).toBe(REPORTING_CHANNELS.length * 3 + 5);
        expect(rows.filter((r) => r.actionable)).toEqual([]);
    });

    it('the page renders no control element at all', () => {
        // The complement of the shape assertions above, read off the component:
        // a row could be marked non-actionable and still have a button beside
        // it. Checked as a count of control elements, which is the property.
        const src = read(
            'src/app/t/[tenantSlug]/(app)/admin/sandbox-runtime/SandboxRuntimeClient.tsx',
        );
        const controls = src
            .split('\n')
            .filter((l) => /<(button|Button|Switch|Toggle|input|Input|Select)\b/.test(l));
        expect(controls).toEqual([]);
    });
});

describe('the citation on the page points at something real', () => {
    it('the named CI check is a test that actually exists', () => {
        /*
            The page tells an admin "held by <check>". If that name drifts, the
            page cites a test that no longer runs and the affordance becomes
            worse than a disabled switch — it is a false reassurance.

            Asserted by searching the guard directories for the literal test
            name, so a rename fails HERE and the renamer updates the citation in
            the same change.
        */
        const files = fs
            .readdirSync(path.join(REPO_ROOT, 'tests/guards'))
            .filter((f) => f.endsWith('.test.ts'));
        expect(files.length).toBeGreaterThan(100);
        const naming = files.filter((f) => read(`tests/guards/${f}`).includes(TIER_C_CI_CHECK));
        expect(naming.length).toBeGreaterThanOrEqual(1);
    });

    it('the named policy module exists and composes both values', () => {
        expect(fs.existsSync(path.join(REPO_ROOT, TIER_C_POLICY_MODULE))).toBe(true);
        const src = read(TIER_C_POLICY_MODULE);
        // Both Tier C values are written there, which is what makes the pointer
        // true rather than merely well-formed.
        for (const setting of ENFORCEMENT_SETTINGS) {
            expect(src.includes(setting.required)).toBe(true);
        }
    });

    it('the pointer reaches the page, not just the display function', () => {
        const src = read(
            'src/app/t/[tenantSlug]/(app)/admin/sandbox-runtime/SandboxRuntimeClient.tsx',
        );
        // Both halves rendered. A module path with no check name tells an admin
        // where to look but not what holds it; the check name alone tells them
        // what holds it but not where.
        expect(src.split('\n').filter((l) => l.includes('policyModule')).length).toBeGreaterThanOrEqual(1);
        expect(src.split('\n').filter((l) => l.includes('ciCheck')).length).toBeGreaterThanOrEqual(1);
    });
});
