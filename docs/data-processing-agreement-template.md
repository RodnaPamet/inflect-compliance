# Data Processing Agreement (template)

> **Engineering draft — NOT a signed agreement.** This is a starting
> point drafted by engineering to make the data-processing posture
> concrete and verifiable. It does **not** replace legal review. Sections
> marked **[LEGAL REVIEW REQUIRED]** contain commercial/legal decisions
> engineering cannot make. The **signed** DPA is legal's deliverable; this
> template feeds it and serves as the source of truth for future updates.

This DPA supplements the Agreement between the **Customer** (data
controller) and **Inflect** (data processor) for the Inflect Compliance
platform.

## 1. Definitions

Terms follow GDPR Article 4:
- **Personal data / PII** — any information relating to an identified or
  identifiable natural person (Art. 4(1)).
- **Processing** — any operation performed on personal data (Art. 4(2)).
- **Controller** — the party determining the purposes and means of
  processing (Art. 4(7)) — the Customer.
- **Processor** — the party processing on the controller's behalf
  (Art. 4(8)) — Inflect.
- **Sub-processor** — a processor engaged by Inflect.
- **Data subject** — the identified/identifiable person (Art. 4(1)).
- **Supervisory authority** — per Art. 4(21).

## 2. Scope and purpose

Inflect processes personal data only to provide the compliance-management
service: storing and managing the Customer's compliance records,
evidence, users, and audit trail. Inflect processes personal data solely
on the Customer's documented instructions (this DPA + the product's
configured use), and not for any independent purpose.

## 3. Sub-processors

The Customer authorises Inflect to engage the sub-processors listed in
the canonical, version-controlled inventory at
[`docs/sub-processors.md`](./sub-processors.md) (reproduced as Annex C, a
point-in-time snapshot). Each sub-processor is bound by data-protection
obligations no less protective than this DPA. New sub-processors are added
per the notification policy in §7 and
[`docs/sub-processor-change-policy.md`](./sub-processor-change-policy.md).

## 4. Confidentiality

Personnel authorised to process personal data are bound by confidentiality
obligations. Access is least-privilege and role-gated (see Annex B).

## 5. Security measures

Inflect maintains the technical and organisational measures in Annex B,
detailed in [`docs/encryption-data-protection.md`](./encryption-data-protection.md)
(encryption at rest + in transit, per-tenant DEK envelope) and
[`docs/epic-c-security.md`](./epic-c-security.md) (API authz, audit-event
streaming, session hardening, rich-text sanitisation). Tenant isolation is
enforced at the database layer by row-level security
([`docs/rls-tenant-isolation.md`](./rls-tenant-isolation.md)).

## 6. Data subject rights

Inflect assists the Customer in responding to data-subject requests
(access, rectification, erasure, portability, restriction, objection).
Request handling and the platform's retention/erasure mechanisms are
described in [`docs/data-retention.md`](./data-retention.md). (A dedicated
DSAR runbook is tracked separately; until it lands, `data-retention.md` is
the operative reference.)

## 7. Sub-processor change notification

Before a new sub-processor begins processing Customer personal data,
Inflect notifies the Customer with at least **30 days'** notice via the
public sub-processor list and an email to the Customer's primary contact,
per [`docs/sub-processor-change-policy.md`](./sub-processor-change-policy.md).
The Customer may object on reasonable data-protection grounds within the
notice window.

## 8. International transfers

Where processing involves a cross-border transfer of personal data out of
the EEA/UK, the transfer relies on an approved mechanism — Standard
Contractual Clauses (SCCs), a UK IDTA/Addendum, an adequacy decision, or
Binding Corporate Rules — as recorded per sub-processor in Annex C /
[`docs/sub-processors.md`](./sub-processors.md). The production deployment
runs in Google Cloud region `europe-west1` (Belgium), with disk snapshots
stored in the `eu` multi-region, so primary data and its backups are
resident in the EEA.

## 9. Audit rights

Inflect makes available the information necessary to demonstrate
compliance with this DPA and allows for and contributes to audits,
including inspections, conducted by the Customer or an auditor it mandates,
subject to reasonable confidentiality and frequency limits. The
sub-processor inventory's codebase cross-references support independent
verification.

## 10. Liability and indemnification

**[LEGAL REVIEW REQUIRED]** — Liability caps, indemnities, and their
interaction with the master Agreement are commercial decisions. Engineering
does not specify monetary limits here.

## 11. Term and termination

**[LEGAL REVIEW REQUIRED]** — Term, termination triggers, and the
end-of-processing data return/deletion timeline are legal/commercial
decisions. (The platform's technical deletion capability is described in
[`docs/data-retention.md`](./data-retention.md); the contractual timeline
is legal's to set.)

## 12. Governing law and jurisdiction

**[LEGAL REVIEW REQUIRED]** — Governing law and forum are commercial
decisions tied to the master Agreement.

## 13. Annex A — Description of processing

- **Subject matter:** provision of the Inflect compliance-management platform.
- **Duration:** the term of the Agreement (see §11).
- **Nature and purpose:** storage, organisation, retrieval, and audit of
  the Customer's compliance data; authentication; transactional email;
  optional billing and tenant-enabled integrations.
- **Categories of data subjects:** the Customer's users (employees,
  auditors, administrators).
- **Categories of personal data:** account identity (email, name, profile
  photo), session/security metadata, and any personal data the Customer
  chooses to place in compliance records/evidence.
- **Special categories:** none required by the platform; the Customer
  controls whether any are entered into free-text fields.

## 14. Annex B — Technical and organisational measures

- **Encryption:** AES-GCM envelope encryption of business-content fields
  with a per-tenant DEK wrapped by a master KEK; TLS in transit; Google
  Cloud encryption at rest for the persistent disk and its snapshots.
  ([`docs/encryption-data-protection.md`](./encryption-data-protection.md))
- **Access control:** RBAC + per-tenant row-level security; API
  permission middleware with hash-chained `AUTHZ_DENIED` audit entries.
- **Auditability:** immutable hash-chained audit log with optional
  per-tenant streaming to the Customer's SIEM.
- **Resilience:** one automated crash-consistent snapshot per day of the
  persistent disk holding the database and uploaded files, retained 14
  days and stored in the EU multi-region. Recovery point up to 24 hours;
  there is no point-in-time recovery and no cross-region failover.
  ([`docs/disaster-recovery.md`](./disaster-recovery.md)).
- **Account security:** breach-password screening (k-anonymity), brute-force
  lockout, session hardening + revocation, optional MFA.

## 15. Annex C — Sub-processor list (snapshot)

This annex is a point-in-time snapshot. The **live, authoritative list**
is [`docs/sub-processors.md`](./sub-processors.md); on any conflict, the
live list governs, and changes follow §7 + the change policy.

| Name | Purpose | Operator-optional? |
|------|---------|--------------------|
| Google Cloud (Compute Engine, Persistent Disk, Snapshots) | Hosting, storage, database and backup for the production deployment | No |
| Google OAuth / Microsoft Entra ID | Authentication | Yes |
| Stripe | Billing (SaaS mode) | Yes |
| SMTP relay (operator-chosen) | Email delivery | No |
| OpenRouter | AI risk suggestions | Yes (off by default) |
| HaveIBeenPwned | Password breach check | No |
| GitHub / Microsoft SharePoint | Tenant-enabled integrations | Yes (per-tenant) |
