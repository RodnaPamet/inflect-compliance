> **Deprecated.** This described a CloudFront CDN provisioned by
> `infra/terraform/modules/cdn`, which was **never applied** and was removed on
> 2026-09-02 with the rest of the AWS estate. There is no CDN in front of
> production; the single GCP VM serves through Caddy.
>
> Superseded by the **Production VM** section of [`CLAUDE.md`](../CLAUDE.md).
> Tracked in
> [#2226](https://github.com/RodnaPamet/inflect-compliance/issues/2226).

# CDN (removed)

The CloudFront design — distribution, cache policies, invalidation on deploy —
is available in the git history at the commit that removed it.
