/**
 * The incident page's reference text is translated (#4697).
 *
 * The containment runbooks, the forensic checklist and the response roles
 * live in English in `src/data/incident-containment.ts`, which the server
 * also reads. The page shows each one from `incidents.containment` in the
 * user's locale. A step, category or role added to the data without a
 * message in every locale would reach a Bulgarian user in English, so every
 * key here must have one, and the English must be the data's own text.
 */
import {
    INCIDENT_CONTAINMENT_RUNBOOKS,
    INCIDENT_RESPONSE_RACI,
    FORENSIC_EVIDENCE_CHECKLIST,
} from '@/data/incident-containment';
import en from '../../messages/en.json';
import bg from '../../messages/bg.json';

type Containment = {
    steps: Record<string, string>;
    roles: Record<string, { role: string; responsibility: string }>;
    forensic: Record<string, { label: string; hint: string }>;
};
const EN = (en as unknown as { incidents: { containment: Containment } }).incidents.containment;
const BG = (bg as unknown as { incidents: { containment: Containment } }).incidents.containment;

const steps = Object.values(INCIDENT_CONTAINMENT_RUNBOOKS).flatMap((rb) => rb.steps);

describe('incident containment messages', () => {
    it('every runbook step has an English message equal to the data, and a Bulgarian one', () => {
        for (const step of steps) {
            expect(EN.steps[step.key]).toBe(step.label);
            expect(BG.steps[step.key]).toEqual(expect.any(String));
            expect(BG.steps[step.key]).not.toBe(step.label);
        }
        expect(Object.keys(EN.steps).sort()).toEqual(steps.map((s) => s.key).sort());
        expect(Object.keys(BG.steps).sort()).toEqual(steps.map((s) => s.key).sort());
    });

    it('every forensic category has a label and a hint in both locales', () => {
        for (const cat of FORENSIC_EVIDENCE_CHECKLIST) {
            expect(EN.forensic[cat.key]).toEqual({ label: cat.label, hint: cat.hint });
            expect(BG.forensic[cat.key]?.label).toEqual(expect.any(String));
            expect(BG.forensic[cat.key]?.hint).toEqual(expect.any(String));
        }
        expect(Object.keys(BG.forensic).sort()).toEqual(FORENSIC_EVIDENCE_CHECKLIST.map((c) => c.key).sort());
    });

    it('every response role has a unique key, and a role and responsibility in both locales', () => {
        const keys = INCIDENT_RESPONSE_RACI.map((r) => r.key);
        expect(new Set(keys).size).toBe(keys.length);
        for (const r of INCIDENT_RESPONSE_RACI) {
            expect(EN.roles[r.key]).toEqual({ role: r.role, responsibility: r.responsibility });
            expect(BG.roles[r.key]?.role).toEqual(expect.any(String));
            expect(BG.roles[r.key]?.responsibility).toEqual(expect.any(String));
        }
        expect(Object.keys(BG.roles).sort()).toEqual([...keys].sort());
    });
});
