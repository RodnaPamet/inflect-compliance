/**
 * Incident-response reference content: per-incident-type containment
 * runbooks, the incident-response RACI, and the forensic evidence
 * collection checklist.
 *
 * Methodology adapted (CC BY 4.0) from
 * [Kshreenath/NIS2-Checklist](https://github.com/Kshreenath/NIS2-Checklist)
 * (© Paolo Carner / BARE Consulting). The per-type containment steps,
 * the six IR roles, and the forensic-collection categories are the
 * source's methodology, rewritten generically here (the source's
 * SMB-/Belgium-specific playbook prose was NOT copied).
 *
 * NOT legal advice. These are operational first-response aids; the
 * tenant's security team + DPO/legal own the actual response.
 */

export type IncidentTypeKey =
    | 'RANSOMWARE'
    | 'DATA_BREACH'
    | 'DDOS'
    | 'UNAUTHORIZED_ACCESS'
    | 'OTHER';

export interface ContainmentStep {
    /** Stable key persisted in Incident.completedContainmentSteps. */
    key: string;
    label: string;
}

export interface ContainmentRunbook {
    title: string;
    /** First-response containment steps, in suggested order. */
    steps: ReadonlyArray<ContainmentStep>;
}

/**
 * Per-incident-type containment runbooks. Keys are stable
 * (`<TYPE>-<n>`) so completion state survives label edits.
 *
 * The English text here is the source the page falls back to. The page
 * reads each title, step, role and forensic category from
 * `messages/<locale>.json` under `incidents.containment` (#4697), and
 * tests/unit/incident-containment-messages.test.ts holds every key here
 * to a message in each locale.
 */
export const INCIDENT_CONTAINMENT_RUNBOOKS: Readonly<
    Record<Exclude<IncidentTypeKey, 'OTHER'>, ContainmentRunbook>
> = {
    RANSOMWARE: {
        title: 'Ransomware containment',
        steps: [
            { key: 'RANSOMWARE-1', label: 'Isolate affected hosts from the network (disable NICs / segment off) — do not power down, to preserve memory.' },
            { key: 'RANSOMWARE-2', label: 'Capture volatile evidence (memory, running processes) before remediation.' },
            { key: 'RANSOMWARE-3', label: 'Identify the ransomware family, encrypted file extensions, and the initial access vector.' },
            { key: 'RANSOMWARE-4', label: 'Verify integrity and isolation of backups (confirm they are offline / immutable and unaffected).' },
            { key: 'RANSOMWARE-5', label: 'Revoke and rotate credentials that may have been exposed; disable compromised accounts.' },
            { key: 'RANSOMWARE-6', label: 'Engage your incident-response retainer / national CSIRT; do not pay or negotiate without legal + executive sign-off.' },
        ],
    },
    DATA_BREACH: {
        title: 'Data breach containment',
        steps: [
            { key: 'DATA_BREACH-1', label: 'Determine the data categories, volume, and subjects affected (scope the exposure).' },
            { key: 'DATA_BREACH-2', label: 'Stop the exfiltration path — revoke tokens/keys, close the exposed endpoint, block the egress.' },
            { key: 'DATA_BREACH-3', label: 'Reset credentials and invalidate sessions for affected accounts.' },
            { key: 'DATA_BREACH-4', label: 'Preserve access logs and the exposure timeline as evidence.' },
            { key: 'DATA_BREACH-5', label: 'Assess GDPR Art. 33/34 obligations with the DPO (personal-data breach notification may apply in parallel to NIS2 Art. 23).' },
            { key: 'DATA_BREACH-6', label: 'Monitor affected accounts/systems for follow-on fraudulent activity.' },
        ],
    },
    DDOS: {
        title: 'DDoS containment',
        steps: [
            { key: 'DDOS-1', label: 'Characterise the attack (volumetric / protocol / application-layer) and identify targeted services.' },
            { key: 'DDOS-2', label: 'Engage upstream DDoS mitigation / scrubbing (provider, CDN, or WAF rate-limiting).' },
            { key: 'DDOS-3', label: 'Apply rate limits, geo/IP filtering, and drop known-bad traffic at the edge.' },
            { key: 'DDOS-4', label: 'Scale or fail over critical services; protect the origin behind the mitigation layer.' },
            { key: 'DDOS-5', label: 'Preserve flow logs / traffic captures for attribution and the post-incident report.' },
            { key: 'DDOS-6', label: 'Confirm the DDoS is not a smokescreen for a concurrent intrusion (watch other signals).' },
        ],
    },
    UNAUTHORIZED_ACCESS: {
        title: 'Unauthorized access containment',
        steps: [
            { key: 'UNAUTHORIZED_ACCESS-1', label: 'Disable the compromised account(s) and revoke active sessions and API tokens.' },
            { key: 'UNAUTHORIZED_ACCESS-2', label: 'Identify the access vector (phished credential, exposed key, vulnerable service) and close it.' },
            { key: 'UNAUTHORIZED_ACCESS-3', label: 'Determine lateral movement and what data/systems the actor reached.' },
            { key: 'UNAUTHORIZED_ACCESS-4', label: 'Rotate secrets the actor could have accessed; enforce MFA re-enrolment.' },
            { key: 'UNAUTHORIZED_ACCESS-5', label: 'Preserve authentication, audit, and host logs as evidence before cleanup.' },
            { key: 'UNAUTHORIZED_ACCESS-6', label: 'Review and tighten access controls / privileged-access paths exploited.' },
        ],
    },
};

/**
 * The six incident-response roles (a reference RACI). Informational —
 * IC does not enforce role assignment.
 */
export interface IncidentRole {
    /** Stable key; the page's labels are `incidents.containment.roles.<key>` (#4697). */
    key: string;
    role: string;
    /** RACI — Responsible / Accountable / Consulted / Informed. */
    raci: 'R' | 'A' | 'C' | 'I' | string;
    responsibility: string;
}

export const INCIDENT_RESPONSE_RACI: ReadonlyArray<IncidentRole> = [
    { key: 'INCIDENT_COMMANDER', role: 'Incident Commander', raci: 'A', responsibility: 'Owns the response end-to-end; declares severity; coordinates the team and decisions.' },
    { key: 'TECHNICAL_LEAD', role: 'Security / Technical Lead', raci: 'R', responsibility: 'Drives containment, eradication, and recovery; directs the technical investigation.' },
    { key: 'FORENSICS', role: 'Forensics / Investigation', raci: 'R', responsibility: 'Collects and preserves evidence; establishes the timeline and root cause.' },
    { key: 'DPO_LEGAL', role: 'DPO / Legal', raci: 'C', responsibility: 'Owns the regulatory/legal determination (NIS2 Art. 23, GDPR Art. 33/34) and notifications.' },
    { key: 'COMMUNICATIONS', role: 'Communications', raci: 'C', responsibility: 'Manages internal and external messaging, including authority and customer comms.' },
    { key: 'IT_OPERATIONS', role: 'IT / Operations', raci: 'R', responsibility: 'Executes isolation, failover, restoration, and infrastructure changes.' },
];

/**
 * Forensic evidence collection checklist — the categories of evidence
 * to capture for an incident, each linkable to a real Evidence record
 * (via IncidentEvidence.forensicCategory).
 */
export interface ForensicCategory {
    /** Stable key stored on IncidentEvidence.forensicCategory. */
    key: string;
    label: string;
    hint: string;
}

export const FORENSIC_EVIDENCE_CHECKLIST: ReadonlyArray<ForensicCategory> = [
    { key: 'SYSTEM_LOGS', label: 'System & application logs', hint: 'Auth, audit, server, and application logs covering the incident window.' },
    { key: 'MEMORY_CAPTURE', label: 'Memory capture', hint: 'Volatile RAM image of affected hosts (capture before power-down).' },
    { key: 'NETWORK_CAPTURE', label: 'Network captures / flow data', hint: 'PCAPs, NetFlow, firewall/IDS logs showing the malicious traffic.' },
    { key: 'DISK_IMAGE', label: 'Disk images', hint: 'Forensic images of compromised endpoints/servers.' },
    { key: 'INDICATORS', label: 'Indicators of compromise', hint: 'Hashes, domains, IPs, file paths, and TTPs observed.' },
    { key: 'TIMELINE', label: 'Incident timeline / notes', hint: 'Investigator notes and the reconstructed sequence of events.' },
];

/** Containment runbook for an incident type, or null for OTHER. */
export function containmentRunbookFor(
    incidentType: string,
): ContainmentRunbook | null {
    if (incidentType in INCIDENT_CONTAINMENT_RUNBOOKS) {
        return INCIDENT_CONTAINMENT_RUNBOOKS[
            incidentType as Exclude<IncidentTypeKey, 'OTHER'>
        ];
    }
    return null;
}
