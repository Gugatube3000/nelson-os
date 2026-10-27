# Procore setup

Procore is Nelson OS's system of record for RFIs, submittals, the schedule and project data. Connecting it is a normal OAuth sign-in: Jonathan clicks **Connect**, signs in to Procore, clicks **Allow**, and Nelson OS starts syncing.

Procore requires every integration to be a registered app that the company has installed. That's a one-time setup in two parts.

## 1. Create the app (Gustavo, about 10 minutes)

1. Sign in at **https://developers.procore.com** → **My Apps** → **Create New App**. Name: `Nelson OS`.
2. **OAuth Credentials → Production.** Set the Redirect URI to exactly:
   ```
   http://localhost
   ```
   (Procore only allows plain `http` for `http://localhost`. During sign-in Nelson OS briefly listens on port 80 to receive the reply, then stops.)
   Copy the **Client ID** and **Client Secret**.
3. **Manage Manifests → Production → Create New Version.** Add a **Data Connection** component using the `authorization_code` grant, save, and **Promote** it. Copy the **App Version ID** (36 characters).
4. Put the Client ID in `config/defaults.json` → `procore.clientId` and push (the ID is not secret).
   **Never commit the Client Secret.** It is entered once in the app (Connections → Procore → App settings) and stored encrypted.

For testing first, use the **Sandbox** credentials and choose *Sandbox* in App settings.

## 2. Install it in Nelson Group's Procore (a Procore company admin, 2 minutes)

Procore → **Company Admin → App Management → Install App → Install Custom App** → paste the **App Version ID** → Install. This needs Admin permission on the company Directory tool.

## 3. Connect (Jonathan)

Nelson OS setup → **Procore** step (or Connections) → **Connect** → sign in → **Allow**. If the Procore account has several companies, pick Nelson Group. Projects, RFIs, submittals and the schedule appear within a few minutes and refresh every 15 minutes.

## How it works

- Nelson OS runs Procore's OAuth itself and keeps the token fresh. Procore rotates refresh tokens, so Nelson OS is the only process that refreshes them.
- Background sync uses Procore's REST API (reads only): active projects, RFIs, submittals (v1.1) and schedule tasks from two weeks back to three months ahead.
- For everything else, the AI uses the bundled [procore-mcp-server](https://github.com/TylerIlunga/procore-mcp-server) (MIT, in `vendor/`), which covers all 3,155 Procore endpoints: daily logs, punch lists, drawings, budgets, commitments, directory and more.

## The approval rule

A change in Procore can email the architect, subs or owner. So **nothing is ever written to Procore without Jonathan's approval**:

- The AI's only Procore write tool, `procore_request_change`, creates an approval card. It never calls Procore.
- The card on the **Approvals** page shows the exact change, who Procore may notify, and why. Only **Approve** applies it.
- New RFIs are proposed as Procore *drafts* (no one is notified) unless Jonathan explicitly asks to issue them.

## Troubleshooting

| Message | Fix |
|---|---|
| "Another program is using port 80" | Close the local web server using port 80 (IIS, Skype for Business, a dev server), then Connect again. |
| "port 80 needs permission" (Linux) | Run `sudo setcap 'cap_net_bind_service=+ep' $(which node)` once, or connect from Windows/Mac. |
| Procore says the app isn't installed | Step 2 hasn't been done for this company. |
| Some projects show no RFIs or submittals | That tool is off on the project, or Jonathan's Procore permissions don't include it. The sync summary in Activity lists what was skipped. |
