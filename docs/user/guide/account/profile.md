---
route: /account/profile
---

# {{ui:account.profile.profileTitle}}

The {{ui:account.profile.profileTitle}} page is where you set your own name and photo. Your name is what other people see in owner and assignee columns across every workspace you belong to.

## Where to find it

Click your picture or initials at the top right of any page, then **{{ui:account.profile.profileTitle}}**. The page has no menu of its own. **{{ui:account.backToWorkspaces}}**, at the top, takes you back: straight to your workspace if you have one, or to the list of your workspaces if you have several.

## Who can use it

Everyone, for their own profile. You cannot change anyone else's name or photo here.

If you signed in through a workspace's single sign-on and you also belong to another workspace or an organization, you cannot change your name or photo in that session: the change would show in places that workspace's sign-in does not vouch for. Sign in with your password, or with Google or Microsoft, to make it.

## What it is for

Set a real first and last name so your colleagues see a person rather than an email address when you own a risk or are assigned a task. Add a photo so you are easy to recognise.

## What you see

**Your photo.** Your photo, or your initials when you have none, with **{{ui:account.profile.uploadPhoto}}**, or **{{ui:account.profile.changePhoto}}** and **{{ui:account.profile.remove}}** when you have one. Under it: {{ui:account.profile.avatarNote}}

**{{ui:account.profile.nameTitle}}.** **{{ui:account.profile.firstName}}** and **{{ui:account.profile.lastName}}**, filled in from your current name, and **{{ui:account.profile.saveName}}**.

## What you can do

### Change your photo

Click **{{ui:account.profile.uploadPhoto}}** or **{{ui:account.profile.changePhoto}}** and choose an image. Your browser crops it to the centre square, shrinks it and removes its metadata before it is uploaded, so the photo's location and camera details never leave your computer. The new photo shows at once.

**{{ui:account.profile.remove}}** removes your photo, and your initials show instead.

### Change your name

Type your first name, last name or both, and click **{{ui:account.profile.saveName}}**. Each part can be up to 100 characters. The message **{{ui:account.profile.nameSaved}}** confirms it.

Your name and photo change everywhere straight away: in the top bar, on this page, and wherever you are named as an owner or assignee. On another device where you are already signed in, the top bar catches up within five minutes.

## What happens next

- Your name shows wherever you are named as an owner, assignee or reviewer, in every workspace.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:account.profile.enterAName}}** | Both name fields are empty | Type at least one |
| The reason the name was refused, such as a name that is too long | The name was not saved | Follow the reason given, then try again |
| **{{ui:account.profile.couldNotSaveName}}** | The name was not saved, and the server gave no reason | Try again |
| **{{ui:account.profile.notReadableImage}}** | The file is not an image your browser can read | Choose a JPEG, PNG or WebP image |
| **{{ui:account.profile.imageProcessingUnavailable}}** or **{{ui:account.profile.webpEncodeFailed}}** | Your browser cannot prepare the photo | Try a different browser |
| The reason the photo was refused, such as an image that is too large | The photo was not uploaded | Follow the reason given, for example by choosing a smaller image |
| **{{ui:account.profile.uploadFailed}}** | The photo was not uploaded, and the server gave no reason | Try again |
| **{{ui:account.profile.couldNotRemovePhoto}}**, or the reason it was refused | The photo was not removed | Try again |
| A message that the change applies to your account in every workspace | You signed in through one workspace's single sign-on, and you belong to other workspaces or an organization | Sign in with your password, or with Google or Microsoft, and make the change again |

## Related

- [{{ui:account.security.securityTitle}}](account-security.md), to change your password.
- [{{ui:mfa.pageTitle}}](mfa.md), to protect your sign-in with a code.
