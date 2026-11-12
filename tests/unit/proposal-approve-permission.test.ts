/**
 * Who may approve a proposal of which kind, as the review surfaces are told
 * (#5053), and how a process map's refusals are worded.
 *
 * `viewerMayApproveProposal` reads the SAME table `approveAgentProposal`
 * asserts (`PROPOSAL_KIND_APPROVE_PERMISSION`), so a surface never offers
 * Approve to a viewer the server would refuse.
 */
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';
import {
    PROPOSAL_KIND_APPROVE_PERMISSION,
    approvePermissionFor,
    viewerMayApproveProposal,
} from '@/lib/agentic/proposal-approve-permission';
import { PROPOSAL_KINDS } from '@/lib/agentic/proposal-labels';
import { proposalRefusalKey } from '@/lib/agentic/proposal-refusal-keys';

const en = require('../../messages/en.json') as { agents: { proposals: { refused: Record<string, string> } } };
const bg = require('../../messages/bg.json') as { agents: { proposals: { refused: Record<string, string> } } };

type Role = 'OWNER' | 'ADMIN' | 'EDITOR' | 'READER' | 'AUDITOR' | 'AI_ADMIN';
const viewer = (role: Role, appPermissions: PermissionSet = getPermissionsForRole(role)) => ({
    permissions: { canWrite: ['OWNER', 'ADMIN', 'EDITOR'].includes(role) },
    appPermissions,
});

describe('the approve-permission table', () => {
    it('names processes.edit for a process map and the route keys for a finding and a risk, per operation', () => {
        expect(PROPOSAL_KIND_APPROVE_PERMISSION).toEqual({
            PROCESS_MAP: { CREATE: 'processes.edit', UPDATE: 'processes.edit' },
            FINDING: { CREATE: 'findings.create', UPDATE: 'findings.edit' },
            RISK: { CREATE: 'risks.create', UPDATE: 'risks.edit' },
            CONTROL: { CREATE: 'controls.create', UPDATE: 'controls.edit' },
            POLICY: { CREATE: 'policies.create', UPDATE: 'policies.edit' },
        });
        expect(approvePermissionFor('PROCESS_MAP')).toBe('processes.edit');
        expect(approvePermissionFor('FINDING')).toBe('findings.create');
        expect(approvePermissionFor('FINDING', 'CREATE')).toBe('findings.create');
        expect(approvePermissionFor('FINDING', 'UPDATE')).toBe('findings.edit');
        expect(approvePermissionFor('RISK', null)).toBe('risks.create');
        expect(approvePermissionFor('RISK', 'UPDATE')).toBe('risks.edit');
        expect(approvePermissionFor('CONTROL', 'UPDATE')).toBe('controls.edit');
        expect(approvePermissionFor('POLICY')).toBe('policies.create');
        // EXTERNAL_WRITE creates no record of ours.
        for (const kind of PROPOSAL_KINDS.filter((k) => !['PROCESS_MAP', 'FINDING', 'RISK', 'CONTROL', 'POLICY'].includes(k))) {
            expect({ kind, key: approvePermissionFor(kind) }).toEqual({ kind, key: null });
        }
        expect(approvePermissionFor('constructor')).toBeNull();
    });
});

describe('viewerMayApproveProposal', () => {
    it.each(['OWNER', 'ADMIN', 'EDITOR'] as const)('%s may approve a process map and a risk', (role) => {
        expect(viewerMayApproveProposal(viewer(role), 'PROCESS_MAP')).toBe(true);
        expect(viewerMayApproveProposal(viewer(role), 'RISK')).toBe(true);
    });

    it.each(['READER', 'AUDITOR', 'AI_ADMIN'] as const)('%s may approve nothing (no role-tier write)', (role) => {
        expect(viewerMayApproveProposal(viewer(role), 'PROCESS_MAP')).toBe(false);
        expect(viewerMayApproveProposal(viewer(role), 'RISK')).toBe(false);
    });

    it('a custom role withholding findings.create may approve a risk, and a finding UPDATE only with findings.edit', () => {
        const editor = getPermissionsForRole('EDITOR');
        const custom = { ...editor, findings: { ...editor.findings, create: false } };
        expect(viewerMayApproveProposal(viewer('EDITOR', custom), 'FINDING', 'CREATE')).toBe(false);
        expect(viewerMayApproveProposal(viewer('EDITOR', custom), 'FINDING', 'UPDATE')).toBe(true);
        expect(viewerMayApproveProposal(viewer('EDITOR', custom), 'RISK', 'CREATE')).toBe(true);
        const noRiskEdit = { ...editor, risks: { ...editor.risks, edit: false } };
        expect(viewerMayApproveProposal(viewer('EDITOR', noRiskEdit), 'RISK', 'UPDATE')).toBe(false);
        expect(viewerMayApproveProposal(viewer('EDITOR', noRiskEdit), 'RISK', 'CREATE')).toBe(true);
    });

    it('a custom role withholding controls.create or policies.create is not offered those approvals (asked before the claim)', () => {
        const editor = getPermissionsForRole('EDITOR');
        const noControls = { ...editor, controls: { ...editor.controls, create: false } };
        expect(viewerMayApproveProposal(viewer('EDITOR', noControls), 'CONTROL', 'CREATE')).toBe(false);
        expect(viewerMayApproveProposal(viewer('EDITOR', noControls), 'CONTROL', 'UPDATE')).toBe(true);
        const noPolicies = { ...editor, policies: { ...editor.policies, create: false } };
        expect(viewerMayApproveProposal(viewer('EDITOR', noPolicies), 'POLICY')).toBe(false);
        expect(viewerMayApproveProposal(viewer('EDITOR'), 'CONTROL')).toBe(true);
        expect(viewerMayApproveProposal(viewer('EDITOR'), 'POLICY')).toBe(true);
    });

    it('a custom role withholding processes.edit on a write-capable base may approve a risk, never a map', () => {
        const custom = { ...getPermissionsForRole('EDITOR'), processes: { edit: false } };
        expect(viewerMayApproveProposal(viewer('EDITOR', custom), 'RISK')).toBe(true);
        expect(viewerMayApproveProposal(viewer('EDITOR', custom), 'PROCESS_MAP')).toBe(false);
    });
});

describe('a process map’s, a finding’s and a risk’s refusals are worded, in both languages', () => {
    it.each([
        ['PROCESS_MAP_PROPOSAL_NOT_EDITABLE', 'processMapNotEditable'],
        ['PROCESS_MAP_APPROVER_NEEDS_PROCESSES_EDIT', 'processMapNeedsProcessesEdit'],
        ['PROCESS_MAP_PROPOSAL_UNREADABLE', 'processMapUnreadable'],
        ['PROCESS_MAP_PROPOSALS_NOT_AVAILABLE', 'processMapNotAvailable'],
        ['FINDING_APPROVER_NEEDS_FINDINGS_CREATE', 'findingNeedsCreate'],
        ['FINDING_APPROVER_NEEDS_FINDINGS_EDIT', 'findingNeedsEdit'],
        ['RISK_APPROVER_NEEDS_RISKS_CREATE', 'riskNeedsCreate'],
        ['RISK_APPROVER_NEEDS_RISKS_EDIT', 'riskNeedsEdit'],
        ['CONTROL_APPROVER_NEEDS_CONTROLS_CREATE', 'controlNeedsCreate'],
        ['CONTROL_APPROVER_NEEDS_CONTROLS_EDIT', 'controlNeedsEdit'],
        ['POLICY_APPROVER_NEEDS_POLICIES_CREATE', 'policyNeedsCreate'],
        ['POLICY_APPROVER_NEEDS_POLICIES_EDIT', 'policyNeedsEdit'],
    ])('%s → refused.%s', (reason, key) => {
        expect(proposalRefusalKey({ error: { details: { reason } } })).toBe(key);
        for (const messages of [en, bg]) {
            const text = messages.agents.proposals.refused[key];
            expect(typeof text === 'string' && text.trim().length > 0).toBe(true);
            // A message the surface renders with no arguments.
            expect(text).not.toMatch(/[{}]/);
        }
    });
});
