# Instructions for AI agents (Claude Code, Codex)

You are installing or maintaining **Nelson OS** for a non-technical user at Nelson Group. Do the work yourself; explain only what the user must click. Do not modify application code unless the user asks.

## Install

1. **Prerequisites.** Git and Node.js 22.13 or newer (`node -v`).
   - Windows: `winget install --id Git.Git -e` and `winget install --id OpenJS.NodeJS.LTS -e`, then open a new shell so PATH updates (or add `C:\Program Files\nodejs` to PATH for this session).
   - macOS: `brew install git node`. Without Homebrew, open https://nodejs.org and have the user run the LTS installer.
2. **Get the code** into `~/Nelson OS` (Windows: `%USERPROFILE%\Nelson OS`):
   - Not there yet: `git -c core.longpaths=true clone <repo-url> "<home>/Nelson OS"` (long paths matter on Windows; then run `git -C "<home>/Nelson OS" config core.longpaths true`)
   - Already there: `git -C "<home>/Nelson OS" pull --ff-only`
   - If the clone asks for credentials, the repo is private: run `gh auth login --web` (install `gh` with winget/brew if needed) and have the user sign in with the GitHub account Gustavo invited.
3. **Run the installer** from that folder:
   ```
   npm install --omit=dev --no-audit --no-fund
   node scripts/setup.mjs
   ```
   This installs dependencies, makes Nelson OS start when the user signs in, puts a **Nelson OS** shortcut on the desktop, registers the Nelson OS MCP server with Claude Code, Codex and Claude Desktop (whichever exist), starts the app, and opens the setup window.
4. **Verify:** `curl http://localhost:4780/api/health` returns `{"ok":true,"app":"nelson-os",...}`.
5. **Hand off to the user.** Tell them to finish the five steps in the Nelson OS window:
   1. Name and title
   2. **Connect your AI.** Claude or ChatGPT; it signs in with their existing subscription. If you (the agent) are Claude Code or Codex, that CLI is already signed in on this computer and shows as connected.
   3. **Connect Procore** (sign in, click Allow; syncs projects, RFIs, submittals, schedule)
   4. **Connect Outlook** (read-only; reads the last 30 days)
   5. First look (data comes in in the background)
   6. Start with your computer

   Stay available until the AI, Procore and Outlook show as connected.

## If something goes wrong

| Problem | Fix |
|---|---|
| Outlook tile says "Needs the one-time Microsoft app setup" | `config/defaults.json` has no `microsoft.clientId`. Ask Gustavo for the Nelson OS client ID and paste it in Connections → Outlook → Set up Microsoft sign-in, or follow `docs/MICROSOFT-APP.md`. |
| Procore tile says "Needs the one-time Procore app setup" | Gustavo's Procore app isn't entered on this computer. Connections → Procore → Set up Procore app, paste the Client ID and Secret Gustavo provides. See `docs/PROCORE-APP.md`. |
| Procore Connect says port 80 is in use | Another local web server is on port 80. Stop it, then Connect again. |
| Microsoft says "Need admin approval" | The Nelson Group Microsoft 365 admin must approve the Nelson OS app once (see `docs/MICROSOFT-APP.md`, Admin consent). |
| Claude/ChatGPT Connect stays on "Waiting for you to sign in" | A browser tab should have opened. If the page shows a code, paste it into the box on the tile. Or run `claude auth login` / `codex login` in a terminal. |
| Port 4780 in use | Something else is on 4780. Set `"port"` in `config/local.json` (e.g. `{ "port": 4781 }`) and re-run setup. |
| App not opening | Check `logs/server.log` in the data folder (Windows: `%LOCALAPPDATA%\NelsonOS`, macOS: `~/Library/Application Support/NelsonOS`). Start manually with `node scripts/launch.mjs`. |

## Update, uninstall, test

- Update: `node scripts/update.mjs` (git pull, install, restart; data is kept)
- Uninstall: `node scripts/uninstall.mjs` (add `--delete-data` to erase all local data)
- Tests: `npm test`

## Rules

- Never print, copy or commit secrets. Tokens and keys live in the encrypted vault in the data folder.
- Don't paste the user's email contents into chat unless they ask. Use the Nelson OS MCP tools to answer questions about projects.
- Nelson OS never sends email. Drafts are opened in Outlook by the user.
- Never send, reply to or forward email or messages on the user's behalf with any tool, and never approve or apply Procore changes yourself. Do not call `/api/approvals/*/approve` or `/api/drafts/*/sent`; those are the user's buttons.
- Never add `Mail.Send` or any write scope, and never weaken `assertReadOnly` in `server/sync/microsoft.js` or the approval gate in `server/sync/procore.js`.
- User data lives outside this folder, so `git pull` never touches it.

## Using Nelson OS from Claude Code or Codex

After setup, the `nelson-os` MCP server provides these tools: `get_briefing`, `list_projects`, `get_project`, `search`, `read_thread`, `list_records`, `ask_drawings`, `create_record`, `update_record`, `draft_email`, `procore_find_endpoints`, `procore_endpoint_details`, `procore_read`, `procore_request_change` (creates an approval only), `local_requirements`. Example: "What's overdue on Fulton St?" or "Draft the RFI about the Unit 4 vanity width and attach the RFI form."
