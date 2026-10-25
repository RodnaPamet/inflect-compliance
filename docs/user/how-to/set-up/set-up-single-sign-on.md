# Set up single sign-on

Connect your workspace to your company's identity provider over OIDC or SAML 2.0, so that people sign in with their company account. You do this together with the IT team that runs the identity provider, check it with a test sign-in, and then, if you want, make single sign-on the only way into the workspace.

## Before you start

- You need the Owner role. Once single sign-on is set up, an Admin can rename the configuration, change its other settings and switch it on, off or to enforced. Only an Owner can change which identity provider it trusts.
- Agree with your IT team which protocol to use, OIDC or SAML 2.0. The page keeps one configuration of each.
- For OIDC, IT gives you an issuer URL, a client ID and a client secret.
- For SAML 2.0, IT gives you the identity provider's entity ID, its sign-in URL and its signing certificate. Inflect does not read a metadata file, so ask for these three values one by one.
- Single sign-on does not create accounts. Each person must already be a member of the workspace, under the email address the identity provider sends.
- Two values below come from your browser's address bar while you use Inflect. *Your Inflect address* is everything before `/t/`. *Workspace* is the part straight after `/t/`.

## Steps

1. Click **{{ui:nav.admin}}**, the gear icon at the bottom of the sidebar. The {{ui:admin.title}} page opens.
2. Under {{ui:admin.section.identity}}, click **{{ui:admin.nav.sso}}**.
3. At the top of the page, click **OIDC** or **SAML 2.0**.
4. Set up both halves for your protocol: your identity provider, and this page. The two sections below say what goes where.
5. Tick **{{ui:admin.sso.enableSso}}**. Leave **{{ui:admin.sso.enforceSso}}** unticked until the test below has passed.
6. Click **{{ui:admin.sso.saveConfig}}**. The message **{{ui:admin.sso.savedOk}}** appears, and the badge on the right reads {{ui:admin.sso.enabled}}.
7. Click **{{ui:admin.sso.testLogin}}**. Your identity provider's sign-in opens in a new tab. Sign in there with your own company account.
8. Check where the new tab lands. If it shows the {{ui:admin.sso.title}} page again, the test passed and your account is now linked. If it shows the Inflect sign-in page with a message, the test failed. The table at the end of this guide helps you find out why.

A test that passes signs your browser in through single sign-on, for this workspace only. To open your other workspaces again, sign out and sign in the way you usually do.

### OIDC

**In your identity provider**, IT creates an OpenID Connect web app for Inflect:

- Set its sign-in redirect URI to `https://<your Inflect address>/api/auth/sso/oidc/callback`. The page does not show this value.
- Let the app send its client secret in the body of the request. Some providers call this `client_secret_post`.
- Make sure the ID token carries the person's email address.
- Sign ID tokens with the provider's own keys, such as RS256, which is every major provider's default. Inflect refuses tokens signed with the client secret (HS256).

**On the page:**

- **{{ui:admin.sso.providerName}}**: a name you recognise. If you leave it empty, it is saved as OIDC Provider.
- **{{ui:admin.sso.emailDomains}}**: optional. List the email domains allowed to sign in this way, separated by commas, such as `acme.com, acme.io`.
- **{{ui:admin.sso.issuerUrl}}**: your identity provider's issuer address, starting with `https://`. Inflect reads the rest of the provider's settings from it, so it must be the issuer exactly as the provider names it.
    - For Microsoft Entra ID, use the address for your own directory, `https://login.microsoftonline.com/<your directory ID>/v2.0`. The shared `common` and `organizations` addresses are refused, because they would let any Microsoft directory sign in.
    - The issuer must be reachable over the internet. If Inflect runs on your company's own servers and your identity provider is on the internal network, ask whoever runs your Inflect installation to allow it.
- **{{ui:admin.sso.clientId}}** and **{{ui:admin.sso.clientSecret}}**: from the app IT created.
- **{{ui:admin.sso.scopes}}**: keep `openid email profile`. Without `email`, the identity provider may not send an email address.

### SAML 2.0

**In your identity provider**, IT creates a SAML app for Inflect:

- Set its ACS URL to the {{ui:admin.sso.acsUrl}} value on the page. Some providers call it the single sign-on URL or the reply URL.
- Set its audience to `https://<your Inflect address>/saml/metadata/<workspace>`. Some providers call this the SP entity ID. The page does not show this value.
- Sign the whole SAML response, not only the assertion inside it, with SHA-256 or SHA-512. A response signed with SHA-1 is refused.
- Send the person's email address as the NameID, or in an attribute named `email` or `mail`.

**On the page:**

- **{{ui:admin.sso.providerName}}** and **{{ui:admin.sso.emailDomains}}**: as for OIDC. An empty name is saved as SAML Provider.
- **{{ui:admin.sso.entityId}}**: the identity provider's entity ID, sometimes called its issuer.
- **{{ui:admin.sso.ssoUrl}}**: the identity provider's sign-in URL for the HTTP-Redirect binding.
- **{{ui:admin.sso.certificate}}**: paste the identity provider's signing certificate.
- **{{ui:admin.sso.nameIdFormat}}**: leave it empty unless IT names another format. Empty means the email address format.

The entity ID, the SSO URL and the certificate are all required.

### Changing the settings later

Once saved, the page shows the {{ui:admin.sso.clientSecret}} and the {{ui:admin.sso.certificate}} as dots. Leave the dots as they are to keep the stored value, or type a new value to replace it. Either way, click **{{ui:admin.sso.saveConfig}}**.

Only an Owner can change the values that say which identity provider to trust: the {{ui:admin.sso.issuerUrl}} and {{ui:admin.sso.clientId}}, or the {{ui:admin.sso.entityId}}, {{ui:admin.sso.ssoUrl}} and {{ui:admin.sso.certificate}}, and the {{ui:admin.sso.emailDomains}}. Admins see these fields greyed out. Saving a change to any of them unlinks every member from the configuration. Nobody is signed out, and each member's next single sign-on sign-in links their account again by email.

## Make single sign-on the only way in

Once the test has passed, you can stop people reaching this workspace any other way.

1. Make sure at least one Owner or Admin of this workspace has an Inflect password and can sign in with it. That person keeps a way in if your identity provider ever stops working. Saving refuses to turn enforcement on until somebody can.
2. If you signed in to Inflect with Google or Microsoft, sign out and sign in with your password or through single sign-on first. Otherwise you lose access to this workspace the moment you save.
3. Tick **{{ui:admin.sso.enforceSso}}**. A notice explains what changes.
4. Click **{{ui:admin.sso.saveConfig}}**. The badge on the right reads {{ui:admin.sso.enforced}}.

From then on:

- Members reach this workspace only by signing in through its single sign-on. Signing in with a password, Google or Microsoft no longer opens it.
- Anyone already signed in another way can no longer open the workspace until they sign in through single sign-on.
- An Owner or Admin who has a password can still sign in with it and reach the workspace. Keep that for when the identity provider is down.
- Someone who belongs to other workspaces as well can still open those after a password sign-in, just not this one.

To stop enforcing, untick **{{ui:admin.sso.enforceSso}}** and save. Unticking **{{ui:admin.sso.enableSso}}** turns single sign-on off altogether, enforcement included.

## What happens next

- **Members sign in from the Inflect sign-in page.** They click **{{ui:login.sso.continue}}**, type the workspace name in **{{ui:login.sso.workspaceLabel}}** and click **{{ui:login.sso.submit}}**. If the workspace has both an OIDC and a SAML configuration enabled, they then pick one.
- **You can share a direct link.** `https://<your Inflect address>/login?sso=<workspace>` opens the sign-in page with the workspace already filled in.
- **The first sign-in links the account.** The first time someone completes a sign-in through your identity provider, Inflect links that identity to their Inflect account.
- **Single sign-on never adds anyone to the workspace.** Invite people from **{{ui:admin.nav.members}}** first, with the email address the identity provider sends.
- **Email domains only restrict.** When {{ui:admin.sso.emailDomains}} lists domains, only addresses on those domains can sign in this way, and an empty field allows any address. Email domains never send anyone to your identity provider: people find single sign-on by workspace name.
- **A single sign-on sign-in opens this workspace only.** Someone who belongs to several workspaces signs in to the others separately.
- **SAML sign-ins must start in Inflect.** A sign-in that starts from your identity provider's own app dashboard is refused.
- **Deleting removes everything.** **{{ui:admin.sso.delete}}** removes the configuration altogether.

## If something goes wrong

When a sign-in fails, the Inflect sign-in page opens with a message. The message is written for the person signing in. For the reason, look in the page address, after `error=`.

| What you see | What it means | What to do |
| --- | --- | --- |
| **Only an Owner can set up single sign-on or change whom it trusts…** when you save | You are not an Owner, and the save would create the configuration or change which identity provider it trusts | Ask an Owner to make that change. You can still save the other settings |
| **Invalid request payload** when you save | A required field is empty, or a value is not in the expected form | Fill in every field for your protocol. URLs must be full web addresses. Domains look like `acme.com` |
| **Enter the client secret for this provider.** or **Enter the certificate for this provider.** when you save | There is no stored value to keep: the configuration is new, or an earlier save lost it | Paste the real value into the field and save |
| **Cannot enforce SSO: at least one admin must have a local password for break-glass access** when you save | No active Owner or Admin of this workspace has a password | Set a password on one of those accounts, then save again |
| **A resource with that unique constraint already exists** when you save | Your OIDC and SAML configurations have the same {{ui:admin.sso.providerName}} | Give this configuration a different name |
| No **{{ui:admin.sso.testLogin}}** button | The saved configuration is not enabled | Tick **{{ui:admin.sso.enableSso}}** and save |
| The new tab shows a short error containing **An error occurred**, instead of your identity provider's sign-in | Inflect cannot reach your identity provider, or read its settings, from the {{ui:admin.sso.issuerUrl}} | Check the {{ui:admin.sso.issuerUrl}} with IT. It must start with `https://` and be reachable over the internet |
| Your identity provider shows an error of its own | It does not accept Inflect's request | Check that the redirect URI (OIDC) or ACS URL (SAML) in its app matches the value in this guide exactly |
| **{{ui:login.sso.notAvailable}}** on the sign-in page | The workspace name is mistyped, or single sign-on is not enabled for it | Check the name after `/t/` in the workspace's address, and that **{{ui:admin.sso.enableSso}}** is ticked |
| **{{ui:login.errors.ssoNoAccount}}** | No member of this workspace has the email address the identity provider sent | Invite that address from **{{ui:admin.nav.members}}**, or correct the address in the identity provider |
| **{{ui:login.errors.ssoDomainNotAllowed}}** | The address's domain is not listed in {{ui:admin.sso.emailDomains}} | Add the domain, or empty the field, then save |
| **{{ui:login.errors.ssoUnavailable}}** | The configuration was switched off, deleted, or cannot be read while the sign-in was under way | Check that the configuration is still enabled and complete, then try again |
| **{{ui:login.errors.ssoStartFromSignIn}}** | The sign-in was started from a link on another website or in an email | Start from the Inflect sign-in page, or share the `/login?sso=<workspace>` link instead |
| **{{ui:login.errors.ssoRequired}}** | The workspace enforces single sign-on, and the person signed in another way | Continue with single sign-on, which the page opens with the workspace filled in |
| **{{ui:login.errors.ssoIncomplete}}**, with `token_error` in the address | Your identity provider refused the client ID or secret | Type the client secret again and save. Check that the app accepts the secret in the request body |
| The same message, with `id_token_invalid` | Inflect could not verify the identity provider's ID token | Check that the {{ui:admin.sso.issuerUrl}} is exactly the issuer the provider names, that tokens are issued to this client ID, and that they are signed with the provider's own keys. For Microsoft Entra ID, use your directory's own address |
| The same message, with `no_email` | The identity provider sent no email address | For OIDC, keep `email` in {{ui:admin.sso.scopes}}. For SAML, send the email as the NameID or in an `email` attribute |
| The same message, with `validation_failed` | Inflect cannot verify the identity provider's SAML response | Check that the certificate is current, the whole response is signed with SHA-256 or SHA-512, the response comes from the entity ID on the page, and the audience matches |
| The same message, with `subject_conflict` | This Inflect account is already linked to a different account at your identity provider | Sign in with the identity provider account that was used the first time |
| The same message, with `missing_relay` | A SAML sign-in started from your identity provider's app dashboard | Start the sign-in from the Inflect sign-in page instead |
| The same message, with `invalid_state` (OIDC) or `invalid_relay` (SAML) | The sign-in did not start on the Inflect sign-in page in this browser, or took more than 10 minutes | Start again from the Inflect sign-in page, and finish in the same browser |
