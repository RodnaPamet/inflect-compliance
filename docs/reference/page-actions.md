# Page actions

Every API call each page can make, the route it reaches and the permission that route checks. The list is generated on every docs build by reading a page's own files and the product components it imports, and finding each `fetch`, API-client helper and `useTenantSWR` read in them.

- **Permission the route checks** is the key the route requires before it runs. "Checked in the use case" means the route names no key of its own and the use case it calls applies the role rules. [Roles and permissions](roles-and-permissions.md) shows which roles hold each key.
- A call the scan could not match is listed under its page with the reason, rather than left out. Most are paths that a parent component passes in.

{{generated:page-actions}}
