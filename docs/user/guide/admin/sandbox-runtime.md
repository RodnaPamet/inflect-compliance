---
route: /t/[tenantSlug]/admin/sandbox-runtime
---

# {{ui:admin.sandboxRuntime.heading}}

The {{ui:admin.sandboxRuntime.heading}} page reports how this deployment has set up its sandbox: the isolated environment agent tools can run in, away from the rest of Inflect. It shows what the deployment declared, what the sandbox reports and where, which security rules it must enforce, and whether agent tools run inside it. It is read-only, and nothing on it is a workspace setting.

## Where to find it

Open the page's address directly, `/t/<workspace>/admin/sandbox-runtime`; the {{ui:admin.title}} page has no button for it.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Owner, Admin |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}**.

## What it is for

When agents run tools for this workspace, a security reviewer will ask where those tools run, what they can reach, and what the sandbox reports and to whom. The sandbox is set up once for the whole deployment, by its operator. This page shows a workspace's administrators what was set up, so they can answer those questions or take them to the operator.

The sandbox reads its configuration once, when it starts, and cannot be asked what it is using. So, as the notice at the top says, **{{ui:admin.sandboxRuntime.noReadApiHeading}}**: every row is what the deployment declared, not something read back from the running sandbox.

## What you see

**The deployment's record.** When a sandbox is declared: the {{ui:admin.sandboxRuntime.digestLabel}}, a fingerprint of the configuration that changes when the configuration does; when it was {{ui:admin.sandboxRuntime.appliedAtLabel}}; and the {{ui:admin.sandboxRuntime.reachabilityLabel}} line, saying whether the sandbox answered the last check and which version it reported. When none is declared, a notice reads **{{ui:admin.sandboxRuntime.notConfiguredHeading}}**.

**{{ui:admin.sandboxRuntime.sectionChannels}}.** {{ui:admin.sandboxRuntime.sectionChannelsNote}} One card per channel:

| Channel | What it is |
| --- | --- |
| {{ui:admin.sandboxRuntime.channel.anonymous-telemetry.name}} | {{ui:admin.sandboxRuntime.channel.anonymous-telemetry.description}} |
| {{ui:admin.sandboxRuntime.channel.otlp-traces.name}} | {{ui:admin.sandboxRuntime.channel.otlp-traces.description}} |
| {{ui:admin.sandboxRuntime.channel.ocsf-file.name}} | {{ui:admin.sandboxRuntime.channel.ocsf-file.description}} |
| {{ui:admin.sandboxRuntime.channel.ocsf-over-otlp.name}} | {{ui:admin.sandboxRuntime.channel.ocsf-over-otlp.description}} |

Each card names the settings that control the channel and what it does when nothing is set: **{{ui:admin.sandboxRuntime.defaultsOn}}** or **{{ui:admin.sandboxRuntime.defaultsOff}}**.

**{{ui:admin.sandboxRuntime.sectionEnforcement}}.** Two rules the sandbox must hold, each with the value it requires:

| Rule | What it means |
| --- | --- |
| {{ui:admin.sandboxRuntime.enforcement.enforcement.name}} | {{ui:admin.sandboxRuntime.enforcement.enforcement.description}} |
| {{ui:admin.sandboxRuntime.enforcement.landlock-compatibility.name}} | {{ui:admin.sandboxRuntime.enforcement.landlock-compatibility.description}} |

Each rule also says where it is set and what holds it: **{{ui:admin.sandboxRuntime.policyModuleLabel}}** {{ui:admin.sandboxRuntime.policyModuleValue}}, and **{{ui:admin.sandboxRuntime.ciCheckLabel}}** {{ui:admin.sandboxRuntime.ciCheckValue}}. So both are fixed in Inflect itself, not left to configuration.

**{{ui:admin.sandboxRuntime.sectionExecution}}.** {{ui:admin.sandboxRuntime.execution.name}}: {{ui:admin.sandboxRuntime.execution.description}} {{ui:admin.sandboxRuntime.executionPlatformBody}}

Every card carries a badge:

| Badge | Meaning |
| --- | --- |
| {{ui:admin.sandboxRuntime.status.declared-not-observed}} | The deployment declared this; the sandbox cannot confirm it |
| {{ui:admin.sandboxRuntime.status.set-in-code}} | Fixed in Inflect itself |
| {{ui:admin.sandboxRuntime.status.unreachable}} | The sandbox did not answer its last check |
| {{ui:admin.sandboxRuntime.status.not-configured}} | No sandbox is declared, so nothing here is in force |
| {{ui:admin.sandboxRuntime.status.unconfirmable}} | Sandboxed execution is turned on, but no sandbox is declared for it to run in, so it cannot work |

## What you can do

Read the page. Every value on it is set by the deployment's operator; take questions or changes to them.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |
| **{{ui:admin.sandboxRuntime.notConfiguredHeading}}** | This deployment has no sandbox | Nothing, unless your agents need one; ask the operator |
| **{{ui:admin.sandboxRuntime.executionUnconfirmableHeading}}** | Sandboxed execution is switched on with no sandbox to run in | Tell the operator |

## Related

- [{{ui:admin.nav.aiFeatures}}](ai-features.md), which chooses the engine that runs agents.
- [{{ui:admin.nav.integrations}}](integrations.md), where agents' external tools are connected.
