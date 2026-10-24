# Page inventory

Every page in the app, grouped the way the app's sidebar groups them, with the page guide that documents it. The list is generated on every docs build from the `page.tsx` files under `src/app/` and from the sidebar definition in `src/components/layout/SidebarNav.tsx`.

- **Page address** is the page's URL pattern. `<workspace>` stands for your workspace's address and a name such as `<riskId>` for an item's identifier.
- A page marked **Redirect** only forwards to another page, and is documented by that page's guide.
- **API calls** counts the distinct API operations the page can make. [Page actions](page-actions.md) lists them.

{{generated:page-inventory}}
