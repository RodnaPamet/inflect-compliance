/**
 * The posture collectors' ARM TABLES — the fixture halves of #2245 / #2266,
 * lifted out of the two suites so a MECHANICAL guard can read them.
 *
 * Class B of #2246 is: *a derived value is byte-identical to a constant in
 * scope, so no assertion can separate them.* The fix shape is a fixture one —
 * run the suite over an arm table pairing a cloud with its own benchmark, its
 * own ids, its own clock, so every derived value differs from every constant
 * BY CONSTRUCTION rather than by predicting sites.
 *
 * What was missing is the part that keeps it true. Round two of that lane
 * changed one fixture value and thereby MOVED the coincidence rather than
 * removing it, and nothing in the tree noticed: the tables were file-local
 * `const`s, so the only check on them was one hand-written assertion about one
 * axis (`wallSkew`). Every other axis — and every axis added later — was
 * unguarded.
 *
 * They live here so `tests/guards/posture-fixture-arm-distinctness.test.ts`
 * can assert the PROPERTY over all axes at once, including axes that do not
 * exist yet:
 *
 *   P1  every axis is pairwise distinct across arms
 *   P2  no arm scalar is byte-identical to a literal constant in the
 *       collector source it drives
 *   P3  the selections P1 and P2 run over are non-empty
 *
 * ADDING AN AXIS: give it a different value in every arm. That is the whole
 * contract, and the guard enforces it — an axis whose arms agree is a
 * file-wide constant wearing a table row, which is the exact shape a literal
 * at any consuming site survives.
 */

export const CLOUD_POSTURE_ARMS = [
    {
        // NOT the collector's own default benchmark. `soc2` is a LITERAL in both
        // collectors (`config.benchmark ?? 'soc2'`), so an arm on `soc2` makes the
        // derived `check` byte-identical to that literal for the whole arm — the
        // exact Class-B shape, surviving only because the OTHER arm disagrees.
        // Mixed case on both arms also means `.toLowerCase()` is exercised twice
        // rather than being the identity here.
        cloud: 'gcp-posture', benchmark: 'Soc2Type2', key: 'soc2type2',
        tenant: 'tenant-cloud-1', conn: 'conn-gcp-4', exec: 'exec-9', elapsed: 250,
        wallSkew: 7_000,
        now: new Date('2026-03-01T12:00:00.000Z'),
        /** EVIDENCE_FRESHNESS_DAYS = 30 after this arm's `now`. */
        thirtyDays: new Date('2026-03-31T12:00:00.000Z'),
        day: '2026-03-01',
        dual: 'storage_account_encryption_enabled',
        soc2Only: 'keyvault_logging_enabled',
        ctl: 'ctl', ev: 'ev',
        // The connection's stored ciphertext, and what it decrypts to. Single
        // fixture values here made `conn.secretEncrypted` — the argument to
        // `decryptField` — byte-identical to the literal `'cipher-blob'`.
        blob: 'cipher-gcp-4f21',
        clientId: 'cid-gcp-11', clientSecret: 'csecret-gcp-11',
        // The provider's own failure text, on the throw path and on the
        // completion path. Both were file-wide constants, so every expression
        // that carries a provider message was pinnable to the one string.
        throwText: 'quota exhausted for project gcp-77',
        nonErrorText: 'weird failure in the gcp collector',
        erroredText: 'collector error for project gcp-77; stderr: ',
    },
    {
        cloud: 'azure-posture', benchmark: 'CIS', key: 'cis',
        tenant: 'tenant-cloud-2', conn: 'conn-az-1', exec: 'exec-3', elapsed: 410,
        wallSkew: 13_500,
        now: new Date('2026-05-09T06:45:00.000Z'),
        thirtyDays: new Date('2026-06-08T06:45:00.000Z'),
        day: '2026-05-09',
        dual: 'compute_disk_encryption_enabled',
        soc2Only: 'audit_log_retention_enabled',
        ctl: 'ctr', ev: 'row',
        blob: 'cipher-az-8b07',
        clientId: 'cid-az-22', clientSecret: 'csecret-az-22',
        throwText: 'subscription throttled in tenant az-31',
        nonErrorText: 'weird failure in the azure collector',
        erroredText: 'collector error in tenant az-31; stderr: ',
    },
] as const;

export const AWS_POSTURE_ARMS = [
    {
        // See the cloud arm above: never the collector's own `'soc2'` default,
        // which is a literal in `aws-posture.ts`.
        benchmark: 'Soc2Type2', key: 'soc2type2',
        tenant: 'tenant-aws-1', conn: 'conn-1', exec: 'exec-1', elapsed: 250,
        wallSkew: 4_250,
        now: new Date('2026-03-01T12:00:00.000Z'),
        /** EVIDENCE_FRESHNESS_DAYS = 30 after this arm's `now`. */
        thirtyDays: new Date('2026-03-31T12:00:00.000Z'),
        day: '2026-03-01',
        mapped: 'iam_root_user_mfa_enabled',
        second: 'guardduty_enabled',
        trailingId: 'inspector_enabled',
        trailingCodes: ['CC3.1', 'CC7.1'],
        ctl: 'ctl', ev: 'ev',
        blob: 'cipher-aws-4f21',
        /**
         * EVERY field the collector puts into `secretVals`, each a DISTINCT
         * value-only secret: none of the AKIA / ASIA / 40-char / session-token /
         * ARN patterns in `scrubAwsCredentials` matches any of them (lowercase
         * prefixes, and hyphens breaking every `\b…\b` run below 40 chars), so
         * the connection's own value list is the ONLY thing that can redact them.
         * That is what makes a field DROPPED from `secretVals` visible.
         */
        secrets: {
            accessKeyId: 'akid-a1-4f21-zyxwvutsr', // pragma: allowlist secret — fabricated, never issued
            secretAccessKey: 'skey-a1-4f21-zyxwvutsr', // pragma: allowlist secret
            sessionToken: 'stok-a1-4f21-zyxwvutsr', // pragma: allowlist secret
            externalId: 'extid-a1-4f21-zyxwvuts',
        },
        throwText: 'sts endpoint unreachable for account a1',
        nonErrorText: 'socket hang up on account a1',
        /**
         * The completion path's lead has to vary per arm too, and the reason is
         * subtle: the SCRUBBED message is what the assertions compare, and every
         * secret in it is `[REDACTED]` by then. Varying only the secrets leaves
         * the scrubbed text byte-identical across arms, so the whole
         * `scrubAwsCredentials(...).slice(0, 500)` expression stayed pinnable to
         * that one string. The lead is the part that survives scrubbing.
         */
        erroredText: 'collector error for account a1',
    },
    {
        benchmark: 'CIS', key: 'cis',
        tenant: 'tenant-aws-2', conn: 'conn-6', exec: 'exec-4', elapsed: 410,
        wallSkew: 21_750,
        now: new Date('2026-05-09T06:45:00.000Z'),
        thirtyDays: new Date('2026-06-08T06:45:00.000Z'),
        day: '2026-05-09',
        mapped: 'iam_user_mfa_enabled',
        second: 'securityhub_enabled',
        trailingId: 'config_enabled_all_regions',
        trailingCodes: ['CC8.1', 'CC7.1'],
        ctl: 'ctr', ev: 'row',
        blob: 'cipher-aws-8b07',
        secrets: {
            accessKeyId: 'akid-b2-8b07-qponmlkji', // pragma: allowlist secret — fabricated, never issued
            secretAccessKey: 'skey-b2-8b07-qponmlkji', // pragma: allowlist secret
            sessionToken: 'stok-b2-8b07-qponmlkji', // pragma: allowlist secret
            externalId: 'extid-b2-8b07-qponmlkji',
        },
        throwText: 'sts endpoint unreachable for account b2',
        nonErrorText: 'socket hang up on account b2',
        erroredText: 'collector error for account b2',
    },
] as const;
