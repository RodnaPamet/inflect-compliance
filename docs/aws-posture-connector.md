# AWS cloud-posture evidence connector

The `aws-posture` integration turns AWS configuration-compliance results into
auto-collected control evidence. It invokes **Powerpipe** with the Apache-2.0
[`steampipe-mod-aws-compliance`](https://github.com/turbot/steampipe-mod-aws-compliance)
benchmark as an **external CLI**, consumes the benchmark's JSON output, and maps
each passing check to the SOC 2 controls it evidences.

> IC does **not** port the mod's HCL/SQL or its embedded framework mappings — it
> runs the CLI and applies its own thin, originally-authored control map
> (`src/data/integrations/aws-posture-control-map.ts`). See the NOTICE section.

## Runtime prerequisites (collector host)

The worker host that runs the `aws-posture-collect` job must have:

- **Steampipe** with the `aws` plugin installed and configured.
- **Powerpipe** with the `steampipe-mod-aws-compliance` mod installed.
- The **AWS CLI** (used by the connection "test" path for a cheap
  `sts:GetCallerIdentity`).

If Powerpipe or the AWS CLI is absent, the connector fails safe: the connection
test reports "CLI not available" and a collection run records an `ERROR`
`IntegrationExecution` (no credentials are ever emitted) rather than throwing.

## Credentials — read-only only

Configure the connection with **read-only** AWS access. Two forms are supported
(assume-role is preferred):

- **Assume-role**: a role ARN + external id. The role's trust policy should
  require the external id.
- **Access key**: a read-only access-key pair (+ optional session token).

Credentials are encrypted at rest (Epic B `encryptField`), passed to the CLI via
**environment variables only** (never on the command line), and scrubbed from any
captured stdout/stderr before results or errors are persisted.

### Minimum read-only IAM policy

Attach AWS-managed `SecurityAudit` + `ViewOnlyAccess`, or the equivalent
customer-managed read-only policy below (example account id is a placeholder):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InflectPostureReadOnly",
      "Effect": "Allow",
      "Action": [
        "sts:GetCallerIdentity",
        "iam:GenerateCredentialReport",
        "iam:Get*",
        "iam:List*",
        "s3:GetBucketPublicAccessBlock",
        "s3:GetEncryptionConfiguration",
        "s3:GetBucketPolicyStatus",
        "cloudtrail:DescribeTrails",
        "cloudtrail:GetTrailStatus",
        "config:Describe*",
        "guardduty:List*",
        "guardduty:Get*",
        "securityhub:Get*",
        "ec2:Describe*",
        "rds:Describe*"
      ],
      "Resource": "*"
    }
  ]
}
```

The connector never mutates AWS resources — every action above is read-only.

### When the credential itself is rejected

A revoked access key, an expired session token or an expired Azure/GCP
credential makes Powerpipe exit non-zero, which is also what a network failure
or a broken mod does. The collector tells them apart from the CLI's stderr and
treats only the first as a credential problem: it marks the connection
(`IntegrationConnection.authFailedAt` / `authFailureReason`, the "credential
revoked" banner in the admin UI), records the `ERROR` execution as usual, and
suppresses the queue's immediate retry — re-running a dead credential three
times inside 35 seconds only delays every other tenant in the fan-out.

The recognised set is deliberately narrow: it holds only provider error codes
that mean the request was never AUTHENTICATED (`ExpiredToken`,
`InvalidClientTokenId`, `UnrecognizedClientException`, `InvalidAccessKeyId`,
`SignatureDoesNotMatch`, `AuthFailure`, and the Azure/GCP equivalents). It
carries no AUTHORIZATION codes — a read-only role missing one `Describe*`
answers `AccessDenied` while the credential is perfectly good, and raising the
banner for that would send an operator to rotate a working key. The full list,
and what is excluded and why, is
`src/app-layer/integrations/posture-credential-classification.ts`.

The banner is cleared by the next run that actually completes (`PASSED` or
`FAILED` — a benchmark reporting real gaps still proves the credential works).
An `ERROR` run does not clear it: the collector never observed the account, so
it has nothing to retract the banner on.

## Configuration

`configJson` on the `aws-posture` connection:

- `benchmark` — `soc2` (default) or `cis`.
- `region` — primary AWS region.
- `accountId` — the target account id (informational).

## What it produces

- One `IntegrationExecution` per run (`automationKey = aws-posture.<benchmark>`,
  `resultJson` = a **bounded** summary: status counts + a per-control status
  array, size-capped at 32 KB — never raw resource dumps).
- For each mapped **passing** control whose SOC 2 requirement the tenant covers,
  a rolling **auto-collected Evidence** row (`category = aws-posture:<check>`,
  `status = APPROVED`, 30-day `nextReviewDate`) linked to the control via a
  `ControlEvidenceLink` of kind `INTEGRATION_RESULT`. Machine-collected evidence
  is clearly marked (category + freshness) so auditors can tell it apart from
  manual attestations.
- Failing / alarm controls are surfaced as a gap signal only — no risks are
  auto-created.

## Framework coverage

The foundation maps to **SOC 2** (IC's SOC 2 Trust Services Criteria — `CC6.*`
logical access, `CC7.*` operations/monitoring, `CC8.*` change management, `CC3.*`
risk assessment). IC's requirement library covers SOC 2 but not NIST CSF 2.0,
which is present only as the maturity-radar domain enum. The connector and
runtime resolver are framework-agnostic — the control map keys on IC requirement
codes, so additional frameworks slot in without connector changes.

## Future work

- Seed a NIST CSF 2.0 framework, then add a `nistCsf` key to the control-map
  entries to crosswalk AWS checks onto CSF subcategories.
- Additional benchmarks (CIS AWS Foundations) and clouds (Azure/GCP posture).

## NOTICE / attribution

This connector executes the Apache-2.0
[`steampipe-mod-aws-compliance`](https://github.com/turbot/steampipe-mod-aws-compliance)
mod (© Turbot HQ, Inc.) via the Powerpipe CLI. No mod source (HCL/SQL) or its
control-to-framework mappings are copied into this repository; only the JSON
benchmark output is consumed at runtime. The IC control map is originally
authored.
