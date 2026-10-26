# Running the agentic IAM use cases as a managed service

Version **1**. The operating methodology for a managed-service provider's IAM
practice (**the provider**) to run the six use cases of
[the agentic IAM plan](agentic-iam-roadmap.md) for a client, on Inflect, as a
managed service. Step `4e`, issue #3682.

**Status: adopted for this repository, and accepted by the provider's practice
lead.** The repository owner's merge of the pull request that added this file
adopted version 1 for this repository. The practice lead's acceptance of
version 1 is recorded on #3682, dated 2026-10-20
([Acceptance](#acceptance)). The text is Inflect-original and reproduces none
of the provider's methodology.

Every product fact here is true of `main`. Where this document states a rule
the product does not enforce, it says so beside the rule, and
[What the product does not hold](#what-the-product-does-not-hold) lists them
together.

## The division of labour

One sentence carries the methodology, and every section below applies it:

> **The provider prepares and watches. The client admits, widens, accepts, approves and
> stops.**

- **The client owns three things outright: the register, the approved skills
  and the kill switch.** The register says which principals are agents, who is
  accountable for each and what each may reach. The approved skills are what
  an agent is taught. The kill switch is what stops one.
- **Every decision on access stays with the client.** That covers a person's
  access and an agent's, a risk acceptance, an approval and a widening.
- **The provider does the work around the decisions.** It deploys and runs the scanner,
  keeps the cadence, triages what the product raises, prepares the material a
  decision needs, drafts skills and reports.
- **Inflect operates the platform.** That covers the deployment and the
  platform-wide kill, which no tenant role reaches (`/api/admin/agent-kill-switch`
  behind `PLATFORM_ADMIN_API_KEY`).

The product makes the split expressible because reading and deciding are
separate keys:
- `admin.agent_registry_view` reads the agent inventory, the scans, the estates'
  health, the runs, the proposals and the governance pack, and decides nothing;
- `admin.agent_registry` admits, retires and configures;
- `admin.agent_kill_switch` stops;
- each of the other agent keys governs one further act.

See [Permission keys](agentic-iam-roadmap.md#permission-keys) for every key and
route.

Three roles appear throughout:

| Role | Who | In the product |
|---|---|---|
| **Client** | The client's own people | OWNER, ADMIN, `AI_ADMIN`, or a custom role, as the right in question needs (table below) |
| **Provider operator** | The provider's staff running the managed service | A custom role built on READER that adds `admin.agent_registry_view`, and nothing that decides (below) |
| **Provider as external auditor** | A team of the provider's auditing the same client | The AUDITOR role, or an auditor account scoped to one pack. It operates nothing ([below](#where-the-provider-is-also-the-clients-external-auditor)) |

## 1. Engagement setup

The client's OWNER does every step in this section. The provider supplies the plan and
checks each step against it.

1. **The tenant and its OWNERs.**
   - The client holds every OWNER membership.
   - A provider member is never an OWNER, an ADMIN or `AI_ADMIN`. Each of those holds
     the register and the kill switch (`src/lib/permissions.ts`).
2. **No provider organisation over the client's tenant.**
   - A tenant may sit under an organisation, and an `ORG_ADMIN` of that
     organisation is provisioned as ADMIN in every tenant under it
     (`src/app-layer/usecases/org-provisioning.ts`).
   - The client's tenant therefore never sits under an organisation in which a
     provider person is `ORG_ADMIN`. An organisation the client uses is the client's
     own.
3. **The client's agent governors.**
   - The OWNER moves the client members who govern agents into `AI_ADMIN` on the
     members page, or maps an Entra group to it.
   - `AI_ADMIN` holds the agent keys and none of the tenant-wide admin keys
     ([The AI_ADMIN role](agentic-iam-roadmap.md#the-ai_admin-role)).
4. **The provider operator role.**
   - An OWNER or ADMIN builds a custom role on READER that adds
     `admin.agent_registry_view` (the admin roles page; `assertCanManageMembers`).
     A custom role never carries a permission its creator does not hold.
   - It may add `audits.workpaper_view` when the client's second line asks the
     provider to support the auditor agent, and never where the provider is the
     client's external auditor.
   - It may add `admin.agent_skill_author` when the client asks the provider to write
     skills. That key authors and submits, and never approves (#3778).
   - It carries no decision key: none of the keys in
     [Who holds which right](#4-who-holds-which-right) that the provider operator
     column marks "no".
5. **Lines of defence.**
   - The OWNER declares each member's line of defence at
     `PUT …/admin/members/:membershipId/line-of-defence` (`admin.owner_management`).
   - The auditor agent's owner must be a SECOND-line client member who owns no
     agent the procedures examine. Internal audit's reviewers are THIRD-line
     client members.
   - The product checks this at registration, at the amend that makes an agent
     an auditor, and at every move to ACTIVE.
6. **The agents that govern are registered first, each with a client owner.**
   - **The scanner agent**, one per estate.
   - **The agent that runs `discovered-agent-review`.**
   - **The agent named to prepare recertification packs.**
   - **The auditor agent.**
   - Each is a registered agent with an accountable owner who is an active
     client member, scored before it is activated (rule 1 of the plan).
7. **Every write ladder starts at DISABLED, and only the client widens it.**
   - The ladders: the owner-orphan pass mode
     (`PUT …/admin/agents/owner-orphan-pass`), the external-write rung of each
     connection (`/admin/external-write-policy`) and the identity ladder
     (`/admin/identity-write-policy`). All three take `admin.tenant_lifecycle`,
     which is OWNER-only.
   - Each widens one rung at a time, and leaves DRY_RUN only after seven days.
     The provider reads the DRY_RUN records and recommends; the OWNER widens.
8. **A2A, where peers are in scope.**
   - The OWNER generates the tenant's A2A signing key (`admin.tenant_lifecycle`).
   - Inbound A2A is refused until the tenant has set both run caps. A holder of
     `admin.agent_registry` sets both on the agents page: the concurrency cap
     (`…/admin/agents/concurrency`) and the monthly token budget
     (`…/admin/agents/budget`, #3777).

**Evidence.** Each step leaves a hash-chained audit row: the membership and
role changes, the custom role, each line-of-defence write, each registration
and activation, each ladder move, and the signing key.

## 2. Scanner deployment

One estate is one client environment covered by one scanner deployment.
[`docs/agent-harness-scanner-onboarding.md`](agent-harness-scanner-onboarding.md)
is the step-by-step; this section says who does each step.

| Step | Who | Where | What it leaves |
|---|---|---|---|
| Register the scanner as an agent, with a client owner | Client | The register (`admin.agent_registry`) | Register row and audit row |
| Trust the scanner's signing key | Client | `POST …/admin/agents/harness-scanner-keys` (`admin.agent_registry`) | Scanner key row, audit row |
| Issue the ingest key: `admin:harness_ingest`, plus `mcp:read` and the `get_harness_register` grant if the register is read | Client | `/admin/api-keys` (`admin.manage`); the agent's tools (`admin.agent_tool_exposure`) | API key bound to the scanner agent; grant row |
| Declare the estate: its cadence and each source with a client owner | Client, from the provider's estate plan | `POST …/admin/agents/harness-estates` (`admin.agent_registry`) | Estate row, audit row |
| Provide a read-only credential per source, from the estate's secret store | Client | The estate | None in Inflect |
| Build the container from a reviewed commit of this repository, run `scan --dry-run`, then `schedule` | Provider | The estate (`packages/agent-harness-scanner/Dockerfile`) | Signed reports |
| Label the estate's principals so owners can be attributed | Provider proposes, client applies | The estate (onboarding doc, section 3) | The labels the scanner reads |

**Whose reports count is the client's decision, at every moment.** The signing
key lives in the estate's secret store. The client can revoke Inflect's trust
in it at `…/harness-scanner-keys/[keyId]`, after which the ingest refuses every
report it signs (`UNTRUSTED_SIGNER`). The ingest key cannot register a signing
key, so a scanner cannot vouch for itself.

**Evidence.** Each verified report leaves:
- an `AGENT_HARNESS_SCAN_INGESTED` audit row carrying the report's digest and
  its signer;
- the scan, its discovered agents and their levels;
- `SHADOW_AGENT`, `UNPINNED_WRITE_TOOL`, `LEVEL_DROP`, `HARNESS_SHORTFALL` and
  `ORPHAN_CREDENTIAL` findings;
- each month's scans as Evidence against OWASP ASI10 and ASI03, marked
  `NEEDS_REVIEW` unless every trusted scanner's latest scan is complete and
  non-empty.

## 3. Cadence

All times are UTC. The scheduled jobs run whether or not the managed service is
engaged; what the service adds is that somebody reads what they leave, every
day.

| Activity | Cadence | Set by | Runs as | What it leaves |
|---|---|---|---|---|
| Harness scan | Every estate cadence, 1 to 720 hours | Client declares; the provider runs the container | The scanner | Scans, findings, monthly evidence |
| Estate staleness | Daily 06:47 | Fixed | `agent-harness-estate-staleness` | One `HIGH` `STALE_ESTATE` finding per stale estate, assigned to the scanner agent's owner |
| Discovered-agent review | On demand, per discovered agent | Client or provider proposes a list; the review agent runs it | `discovered-agent-review` on Flue, as the registered review agent | A stored owner suggestion per agent, shown on the shadow list |
| Identity chain | Daily 03:00, 04:00, 04:30, 05:00 | Fixed | Sync, HRIS, joiner, leaver | Execution rows; the directory write journal |
| Owner-orphan pass | Daily 05:15 | The OWNER sets the mode | `agent-owner-orphan-pass` | Execution rows; at AUTOMATIC, `OWNER_DEPARTED` kills and suspensions |
| Credential hygiene | Daily 06:00 | Rotation age by the OWNER or ADMIN | `agent-credential-hygiene` | Findings, never a credential change |
| Kill-switch drill | Daily 06:00 | Fixed | `agent-kill-switch-drill` | A drill row and Evidence each run; a `CRITICAL` finding on failure |
| Agentic evidence emission | Daily 06:30 | Fixed | `agentic-evidence-emission` | Per-period evidence artefacts |
| Integration passport | Weekly, Sunday 05:45 | Fixed | `integration-passport-sweep` | Drift findings; the week's passports as Evidence |
| Harness acceptance expiry | Daily 04:30 | Fixed | `exception-expiry-monitor` | A lapsed acceptance reopens its finding |
| Proposal sample audit (ASI09) | Weekly, Monday 09:30 | Fixed | `agent-proposal-sample-audit` | A retrospective review of each sampled approved proposal |
| Agent recertification | By hand: nothing schedules a campaign | The client's access-review policy; the provider keeps the calendar | A person creates it; registered agents prepare the packs | The closing evidence document |
| Audit procedures (library v1) | Monthly procedures on the 2nd at 06:17; quarterly on the 2nd of each quarter's first month | The auditor's owner sets each plan | The auditor agent on the control-test runner | One workpaper per procedure and period; a finding proposal per exception |
| Workpaper narrative | Daily 08:50, one run per tenant | Fixed | `audit-narrative-dispatch`, as the auditor agent under its owner's permissions | A narrative per workpaper, held to its record |
| Workpaper sampling | Daily 09:40 | Internal audit sets the rate | `audit-workpaper-sample-review` | An assignment per drawn workpaper; the agreement rate |
| Reliance pack | Per audit cycle | The client | A person, on the cycle page | A frozen pack shared with the external auditor |

The provider's own rhythm sits on top of this table:
- **Daily:** triage what the jobs left.
- **Monthly:** a report to the client (below).
- **Per period:** read the workpapers and their reviews where the client has
  asked for that support.

## 4. Who holds which right

"Client" names the built-in roles that hold the key on `main`; a client may
also give it to a client member through a custom role. "No" means the person in
that column never holds the key, whatever role they are given. A cell that
marks a rule the product does not enforce says so.

| Right | Key or rule | Client | Provider operator | Provider as external auditor |
|---|---|---|---|---|
| Read the inventory, scans, estate health, runs, proposals, governance pack | `admin.agent_registry_view` | OWNER, ADMIN, `AI_ADMIN`, AUDITOR | **Yes** | **Yes**, through AUDITOR |
| Register, activate, suspend, retire an agent; intake a shadow agent | `admin.agent_registry` | OWNER, ADMIN, `AI_ADMIN` | No | No |
| Trust or revoke a scanner key; declare an estate; register or pin an A2A peer | `admin.agent_registry` | OWNER, ADMIN, `AI_ADMIN` | No | No |
| Grant an agent a tool | `admin.agent_tool_exposure` | OWNER, ADMIN, `AI_ADMIN` | No | No |
| Write an agent's policy card | `admin.agent_policy_card` | OWNER, ADMIN, `AI_ADMIN` | No | No |
| Engage or lift a kill: one agent, the whole tenant, or a peer | `admin.agent_kill_switch` | OWNER, ADMIN, `AI_ADMIN` | No | No |
| Accept an external tool definition | `admin.agent_external_tools` | OWNER, ADMIN, `AI_ADMIN` | No | No |
| Move an agent's accountable owner | `admin.agent_ownership` | OWNER, `AI_ADMIN` | No | No |
| Author a tenant skill: create, version, attach its record, submit | `admin.agent_skill_author` | OWNER, ADMIN, `AI_ADMIN` | Yes, where the client asks the provider to author (below) | No |
| Approve, reject or retire a tenant skill | `admin.agent_skill_review`, never the version's author | OWNER, ADMIN, `AI_ADMIN` | No | No |
| Set the monthly token budget and the concurrent-run cap | `admin.agent_registry` | OWNER, ADMIN, `AI_ADMIN` | No | No |
| Accept a harness shortfall | The agent's accountable owner, under `admin.agent_registry` | The agent's owner | No | No |
| Confirm an agent's service-principal link | `admin.agent_registry` | OWNER, ADMIN, `AI_ADMIN` | No | No |
| Classify a provisional AI-system entry | `assertCanWrite` | Writers | No | No |
| Create, decide, close a recertification campaign; answer its sample | `access_reviews.*`, and the assigned reviewer | Client reviewers | No | No |
| Approve an agent's proposal | Write on the domain it changes | Client writers | No | No |
| Set a write ladder's mode, the orphan pass's mode, the A2A signing key | `admin.tenant_lifecycle` | OWNER | No | No |
| Declare a member's line of defence | `admin.owner_management` | OWNER | No | No |
| Set, change or stop an audit procedure plan | Only the auditor agent's owner (`AUDIT_PROCEDURE_PLAN_OWNER_ONLY`) | A SECOND-line client member | No | No |
| Re-perform a sampled workpaper; set the sampling rate | The assigned THIRD-line reviewer; internal audit | Client internal audit | No | No |
| Read the workpapers | `audits.manage` or `audits.workpaper_view` | OWNER, ADMIN | Only with `audits.workpaper_view`, at the client's request | No: reads them in the reliance pack |
| Assemble the reliance pack and share it | `audits.manage` and `admin.manage` | OWNER, ADMIN | No | No |
| Read a shared reliance pack | A pack-scoped auditor account or share link | n/a | n/a | **Yes** |
| Issue or revoke an API key | `admin.manage` | OWNER, ADMIN | No | No |
| Stop every agent on the deployment | `PLATFORM_ADMIN_API_KEY` | Inflect | No | No |

**The provider authoring a skill.** Authoring takes its own key,
`admin.agent_skill_author`, separate from approval since #3778. A provider author
holds it through the operator's custom role. The product refuses every
approval, rejection and retirement to that role, which does not carry
`admin.agent_skill_review`. Separately, it refuses a version's approval by its
own author, in the usecase and by a CHECK, whoever holds both keys. Each
approval's audit row names its approver, and the monthly report lists them.

## 5. Escalation

The provider raises; the person in the last column decides. The engagement letter sets
the response times. This section sets the path.

| Signal | Where it shows | Owned by | The provider's first response | Who decides |
|---|---|---|---|---|
| An agent acts outside its card, or a credential is suspected exposed | Run ledger, proposals, quarantine, decision log | The agent's owner | Tell the client's kill holder at once, with the run and the evidence | The client's kill holder engages the agent kill (`POST …/admin/agents/kill-switch` with `agentId`); its owner decides what follows |
| Several agents at once, or a shared tool | The same, across agents | The tenant's OWNERs | As above, recommending the tenant-wide kill | The client's kill holder (`…/kill-switch` without `agentId`) |
| A suspected platform fault | Any | Inflect | Report it through Inflect's incident process ([`docs/incident-response.md`](incident-response.md)) | Inflect, which alone holds the platform-wide kill |
| The kill-switch drill fails | A `CRITICAL` finding | The tenant | Escalate the same day; the client treats every kill as unproven until a drill passes | The client's security owner, with Inflect |
| A shadow agent | `SHADOW_AGENT` finding; the shadow list | The client | Run the discovered-agent review; prepare the intake with the stored suggestion | A holder of `admin.agent_registry` confirms the owner and registers it |
| An agent below the harness bar | `HARNESS_SHORTFALL` finding | The agent's owner | Recommend the fix, or a bounded acceptance | The agent's owner fixes or accepts, for at most 365 days |
| A stale estate | `STALE_ESTATE` finding, the estate card | The scanner agent's owner | Restore the scanner or the source credential | The scanner agent's owner closes it with a complete scan |
| An owner leaves | Orphan pass record; `AGENT_OWNER_DEPARTED` notice to the OWNERs | The OWNERs | Name the transfer candidate (the departed owner's manager where known) | Two-step transfer by `admin.agent_ownership`; the new owner lifts the kill |
| Passport drift | Drift finding | The connection's accountable owner | Explain the change from the passports | The connection's owner |
| A weak credential | Hygiene finding | The agent's owner, else the key's creator, while an active member | Recommend rotation or revocation | A holder of `admin.manage` |
| A peer misbehaves or its card changes | Peers page, signed messages, refused admissions | The peer's accountable owner | Recommend the peer kill, or a review of the new card | The client's kill holder; a holder of `admin.agent_registry` re-approves a card |
| A workpaper exception | A finding proposal | The proposal queue | Read it against the workpaper | A person, never the auditor agent |
| Internal audit dissents | A finding proposal from the dissent | Internal audit | None: internal audit's own matter | Somebody other than the dissenter |

## 6. Every activity, its surface and its evidence

This is the methodology's acceptance test: an activity with no product surface
or no evidence is named as such, not left out.

| Use case | Activity | Product surface | Evidence it produces |
|---|---|---|---|
| UC1 | Scan an estate | The scanner container; `POST …/admin/agents/harness-scans` | Audit row with digest and signer; scan; levels; findings; monthly Evidence on ASI10 and ASI03 |
| UC1 | Watch the estates' schedule health | Harness tab on `/agents/reports`; `GET …/admin/agents/harness-estates` | `STALE_ESTATE` finding; the staleness pass's execution row |
| UC1 | Read the harness matrix and the shadow list | Harness tab on `/agents/reports` | None of its own: it reads the scans |
| UC1 | Accept a shortfall | Harness tab; `…/admin/agents/harness-acceptances` | Acceptance row with expiry; audit row; reopened finding on lapse |
| UC2 | Take a shadow agent into the register | The shadow list's Register action; `POST …/admin/agents/intake` | DRAFT register row; provisional AI-system entry; audit row with the suggestion's provenance |
| UC2 | Classify the agent's AI-system entry | The AI-system page; `POST …/ai-systems/:systemId/classification` | Classification, linked obligations, audit row |
| UC2 | Retire an agent | `DELETE …/admin/agents/[agentId]` | The cascade's summary audit row; withdrawn per-agent evidence for open periods |
| UC2 | Transfer an agent's ownership | `…/admin/agents/[agentId]/ownership-transfer` and `…/complete` | Transfer row; audit rows for both steps |
| UC2 | Contain the agents of a departed owner | Owner-orphan pass; `GET …/admin/agents/owner-orphan-pass` | Execution rows; `OWNER_DEPARTED` kill rows; the service-principal disable through the external-write journal |
| UC2 | Find weak agent credentials | Credential hygiene job | `AGENT_CREDENTIAL_HYGIENE` findings |
| UC3 | Recertify agents | `POST …/access-reviews/agents`; the access-review pages | Frozen subjects; packs with hashes; narrowings; the closing JSON evidence on ISO/IEC 27001 A.5.18, SOC 2 CC6.1 and ASI03; the decision sample |
| UC3 | Narrow a grant the evidence does not support | `…/agent-narrowings/[id]` | Grant deleted; one-way stamp |
| UC3 | Review a sample of approved proposals | `agent-proposal-sample-audit` | A retrospective review per sampled proposal; the disagreement rate |
| UC4 | Run the audit procedures | The control-test runner, as the auditor agent | One workpaper per procedure and period; finding proposals |
| UC4 | Narrate a period's workpapers | `audit-narrative-dispatch`, or `POST …/agent-runs` | A narrative per workpaper, write-once and encrypted, on the review sheet |
| UC4 | Re-perform a sample | `/audits/workpaper-reviews` | One-way review answer; the workpaper's review stamp; a finding proposal per dissent |
| UC4 | Report the agreement rate | The governance pack on `/agents/reports` | The rate with its definition |
| UC4 | Package reliance for the external auditor | `POST …/audits/cycles/:cycleId/reliance-pack`; the cycle page | A frozen audit pack with its limits; pack-scoped access |
| UC5 | Read a connection's passport | The connection's page under the integrations admin page | The week's passports as Evidence on ASI04, ASI03, ISO/IEC 27001 A.5.19 and A.5.15, SOC 2 CC9.1 and CC6.1; drift findings |
| UC5 | Register and pin an A2A peer | `/agents/peers`; `…/admin/agents/peers` | Peer row; the pinned card hash; audit rows |
| UC5 | Exchange A2A tasks | `POST /api/a2a/:tenantSlug/peers/:peerId` inbound; the `a2a-peer` connection outbound | Signed, write-once `PeerAgentMessage` receipts; outbound sends in the external-write journal |
| UC5 | Stop a peer | The peer's page; `…/admin/agents/peers/[peerId]/kill` | Kill rows; `PEER` scope in the drill |
| UC6 | Author and approve a tenant skill | The Skills tab on `/agents/reports`; `…/admin/agents/skills/tenant/**` | Versions with content hash and recomputed evaluation record; audit rows naming author and approver |
| UC6 | Prove what a run was taught | The run detail page | `WorkflowRun.mountedSkills`: name, version, hash and origin of each mounted skill |
| All | Prove a kill works | `agent-kill-switch-drill` | Drill row and Evidence each day; `CRITICAL` finding on failure |
| All | Report to the client each month | The governance pack on `/agents/reports` | The pack itself; filed into the evidence library only by a holder of `admin.agent_registry` and `evidence.edit` |

## 7. The client's ownership

Each of the three is stated, then held: by the product where it can be, and by
this methodology where it cannot.

**The register.**
- **Stated:** only the client decides which principals are agents, who is
  accountable for each and what each may reach.
- **Held by the product:**
  - Every register write takes `admin.agent_registry`, and the provider operator role
    does not carry it.
  - A scan never writes the register. A shadow agent enters it only when a
    person confirms an owner who is an active client member.
  - Whose scans count is the client's list of trusted signing keys.
  - A grant takes `admin.agent_tool_exposure`, a card `admin.agent_policy_card`,
    an owner move `admin.agent_ownership`; the provider holds none of them.

**The approved skills.**
- **Stated:** only the client decides what its agents are taught.
- **Held by the product:**
  - A skill mounts only with a passing evaluation record.
  - A tenant skill mounts only once a person other than its author approves its
    content hash, and an edit is a new version that serves nothing until it is
    approved.
  - Every run pins the hash it was taught with.
  - Approving takes `admin.agent_skill_review`, which the provider operator role does
    not carry; writing a skill takes `admin.agent_skill_author` alone (#3778).
- **Licensing:** the provider's methodology enters as tenant skill text under
  the provider's own licence and source fields. The repository corpus stays Inflect-original
  (decision 5 of the plan).

**The kill switch.**
- **Stated:** only the client stops its agents and its peers, and only the
  client lifts a stop.
- **Held by the product:**
  - `admin.agent_kill_switch` is held by OWNER, ADMIN and `AI_ADMIN`, and never
    by the provider operator role.
  - An engagement and a lift each need a stated reason. An `OWNER_DEPARTED` kill lifts only for
    the agent's new owner after a completed transfer, which a database trigger
    enforces.
  - The kill is drilled daily.
- **Inflect's part:** Inflect holds the platform-wide kill. A client cannot
  reach it, and neither can the provider.

**When the engagement ends.** A provider member's membership is removed, or set
inactive, by the client. The provider owns no agent, so the orphan pass contains
nothing when the provider leaves, and no authority moves.

## Where the provider is also the client's external auditor

Where the provider audits the client, whether the financial statements or the
control environment these agents operate in, operating any part of the service
would have the provider auditing its own work. In that engagement the provider's
access is the AUDITOR role or a pack-scoped auditor account, and the provider
does not:

1. **Operate the scanner, or hold its signing key or its ingest key.** The
   inventory of principals is a control under audit.
2. **Run the cadence or triage the findings.** Triage decides what reaches a
   decision-maker.
3. **Author, maintain or approve a tenant skill**, above all one mounted by a
   workflow whose output the audit relies on.
4. **Own any agent**, the auditor agent included, or set an audit procedure
   plan. The auditor agent is the client's second line.
5. **Re-perform a sampled workpaper, or set the sampling rate.** That is the
   client's internal audit, and its agreement rate is what the reliance pack
   reports.
6. **Prepare a recertification pack, decide a subject or narrowing, or answer a
   decision sample.**
7. **Accept a risk, approve a proposal, confirm a service-principal link,
   classify an AI-system entry, or widen any ladder.**
8. **Hold a kill switch or lift a kill.**
9. **Assemble or share the reliance pack.** The client assembles it, and the
   provider reads it through the access the client grants.
10. **Write the provider's own methodology references into the procedure catalogue**
    ([`docs/agentic-audit-procedures.md`](agentic-audit-procedures.md)) for a
    client it audits, beyond recording them by name.

What the product holds here, and what it does not:
- **The product cannot tell a provider member from a client member, or know that
  the provider is the auditor.** The restriction is held by the roles the client's OWNER
  assigns.
- **It can be checked from the record.** Every membership and role change is a
  hash-chained audit row, and the members page shows each member's role.
- **This methodology does not decide whether the provider may audit a period in
  which it operated the service.** The provider's own independence rules decide
  that. The audit
  trail answers the question of fact: who held which key, and who acted, in
  that period.

## What the product does not hold

- **Nothing schedules a recertification campaign.** The provider keeps the calendar, and
  a person starts each campaign.
- **The scan reads identities and credentials, not every grant.** The `cicd`
  source (#3784) reads a repository's workflows and Actions secrets, and does
  not list organisation or environment secrets: a reference to one is reported
  with its age unknown. The `gcp-sa` source (#3785) reads a project's service
  accounts and their user-managed keys, and not their role bindings. The provider states
  both limits in each report rather than reporting a complete inventory of
  grants.
- **No real vendor's agent has exchanged an A2A task** (#3752). The peer path is
  proven against an in-process fake peer.
- **The procedure catalogue is adopted for this repository, not approved or
  agreed.** Internal audit's approval and the provider's agreement are open for
  version 1 on #3663 and for version 2, the version in force, on #4379, and each
  procedure's provider methodology reference is open too.
  The reliance pack states both as limits.

## The monthly report

The provider reports to the client once a month. The report cites the product rather
than restating it:
- the governance pack for the month;
- each estate's schedule health, and every source no complete scan read;
- the findings opened and closed, by kind;
- the drills;
- the passports' drift;
- the campaigns run and due;
- the agreement rate with its definition, where the auditor agent runs;
- every skill version approved, with its approver;
- each entry of [What the product does not hold](#what-the-product-does-not-hold)
  that applied that month.

## Acceptance

- **The acceptance.** The practice lead of the provider's IAM practice accepted
  version 1 on 2026-10-20, as the text stood at commit `f55d00ec1`. The
  acceptance is recorded on #3682. This document does not name the provider.
- **The evidence filing.** Inflect files the accepted version as Evidence in
  its own tenant against ISO/IEC 27001:2022 A.5.19, A.5.20 and A.5.22: the
  supplier relationship, its agreement and its monitoring.
- **A change** is a pull request to this file that raises the version. The
  practice lead's acceptance of the new version is recorded on its issue when
  given. An editorial change that alters no role, right, rule or activity does
  not raise the version, and its pull request says so. Replacing the provider's
  name with "the provider" (2026-10-20) was such a change.
