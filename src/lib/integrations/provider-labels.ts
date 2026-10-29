/**
 * The integration provider ids the admin catalogue carries a name for, under
 * `admin.integrations.providerLabels.<id>` in both message catalogues.
 *
 * A provider's `displayName` is an English string written in its server-side
 * class, so rendering it put English under the Bulgarian UI, and two of them
 * name the protocol rather than the thing ("MCP server (external)", "Legacy
 * application (MCP)") — words this product does not show to the people using
 * it (#4466). The page shows the catalogue's name for an id listed here, and
 * the server's `displayName` only for an id this build does not know.
 *
 * A local set rather than a `t.has()` probe, for the reasons `check-labels.ts`
 * gives. `tests/unit/integrations/provider-labels.test.ts` pins it against every
 * registered provider and against both catalogues, and refuses "MCP" in any
 * label.
 *
 * `sharepoint` is here although it is not in the provider `registry` (it is an
 * `integrationRegistry` bundle): its connections still appear in the health
 * panel, which names them by this map.
 */
export const LABELLED_PROVIDERS: ReadonlySet<string> = new Set([
    // Identity directories.
    'okta',
    'google-workspace',
    'entra-id',
    'active-directory',
    // Legacy applications.
    'legacy-mcp',
    // Cloud posture.
    'aws-posture',
    'azure-posture',
    'gcp-posture',
    // Source control.
    'github',
    // HR systems.
    'bamboohr',
    'workday',
    'orangehrm',
    // Internal checks.
    'personnel',
    'device',
    'training',
    // ITSM.
    'servicenow',
    // Agent connections.
    'mcp-server',
    'a2a-peer',
    // Documents (its own card on the page).
    'sharepoint',
]);
