# One-time Microsoft app setup (for Outlook)

Nelson OS signs in to Outlook with standard Microsoft OAuth. Microsoft requires every app to have a registration, so this is done **once** by Gustavo (or the Nelson Group Microsoft 365 admin). After that, everyone just clicks **Connect**.

It takes about 5 minutes and needs no secret.

## Register the app

1. Go to **https://entra.microsoft.com** → **Applications → App registrations → New registration**.
   (A personal Microsoft account works too: https://portal.azure.com → Microsoft Entra ID → App registrations.)
2. **Name:** `Nelson OS`
3. **Supported account types:** *Accounts in any organizational directory and personal Microsoft accounts*.
4. **Redirect URI:** platform **Public client/native (mobile & desktop)**, value:
   ```
   http://localhost:4780/oauth/microsoft/callback
   ```
5. Click **Register** and copy the **Application (client) ID**.
6. Optional but tidy: **API permissions → Add → Microsoft Graph → Delegated**: `User.Read`, `Mail.Read`, `Calendars.Read`, `Files.Read.All`, `offline_access`. (Nelson OS asks for these at sign-in anyway.)

## Ship the ID to every install

Put the ID in `config/defaults.json`, then commit and push:

```json
"microsoft": { "clientId": "PASTE-THE-ID-HERE", "tenant": "common" }
```

Installs that already exist pick it up after `node scripts/update.mjs`. Or paste it into **Connections → Outlook → Set up Microsoft sign-in** on one computer.

## Nelson Group's Microsoft 365 (checked 2026-10-27 from public DNS)

- `@nelsongc.com` mail is **Microsoft 365 / Exchange Online, bought through GoDaddy** (tenant `NETORGFT17343503.onmicrosoft.com`; `autodiscover` → `outlook.com`). The Outlook connection works with it.
- Sign-in is federated: after Jonathan types his email, Microsoft sends him to **GoDaddy's sign-in page**. He uses his normal email password there, then sees the Microsoft "Nelson OS wants to read your mail" screen and clicks **Accept**.
- Incoming mail passes through Proofpoint filtering first; that doesn't affect reading the mailbox.
- GoDaddy-run tenants often require **admin approval** for outside apps. If Jonathan sees "Need admin approval", Nelson OS shows an **Open approval page** button and a link to send to the admin (below).

## Admin consent (Microsoft 365 work accounts)

Some organizations block users from approving apps. If Jonathan sees **"Need admin approval"**, a Microsoft 365 admin opens this link once (replace the ID) and clicks **Accept**:

```
https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=PASTE-THE-ID-HERE&scope=https://graph.microsoft.com/.default&redirect_uri=http://localhost:4780/oauth/microsoft/callback
```

Nelson OS builds this link automatically when it detects the "needs admin approval" response. For a GoDaddy-run tenant, the admin is the account that manages the Microsoft 365 plan in GoDaddy. If that account can't approve apps, GoDaddy support can grant admin consent for the app's client ID.

## What Nelson OS can and can't do with this access

| Scope | Used for |
|---|---|
| `Mail.Read` | Read inbox and sent mail (last 30 days on first run, then new mail every 10 minutes) and attachments the user chooses to add to a project |
| `Calendars.Read` | Show the next three weeks of meetings and inspections |
| `Files.Read.All` (only if OneDrive is connected) | Find and import drawing PDFs from OneDrive/SharePoint |
| `User.Read`, `offline_access` | Know whose mailbox it is; stay signed in |

There is no send, write or delete permission. Tokens are stored encrypted on the computer (Windows DPAPI / macOS Keychain).
