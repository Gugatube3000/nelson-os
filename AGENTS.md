# Instructions for AI agents (Claude Code, Codex)

You are installing or maintaining **Nelson OS** for a non-technical user at Nelson Group. Do the work yourself; explain only what the user must click. Do not modify application code unless the user asks.

## Install

1. **Prerequisites.** Git and Node.js 22.13 or newer (`node -v`).
   - Windows: `winget install --id Git.Git -e` and `winget install --id OpenJS.NodeJS.LTS -e`, then open a new shell so PATH updates (or add `C:\Program Files\nodejs` to PATH for this session).
   - macOS: `brew install git node`. Without Homebrew, open https://nodejs.org and have the user run the LTS installer.
2. **Get the code** into `~/Nelson OS` (Windows: `%USERPROFILE%\Nelson OS`):
   - Not there yet: `git clone <repo-url> "<home>/Nelson OS"`
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
   3. **Connect Outlook** (read-only; reads the last 30 days)
   4. First look (email is read in the background)
   5. Start with your computer

   Stay available until the AI and Outlook show as connected.

## If something goes wrong

| Problem | Fix |
|---|---|
| Outlook tile says "Needs the one-time Microsoft app setup" | `config/defaults.json` has no `microsoft.clientId`. Ask Gustavo for the Nelson OS client ID and paste it in Connections → Outlook → Set up Microsoft sign-in, or follow `docs/MICROSOFT-APP.md`. |
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
- User data lives outside this folder, so `git pull` never touches it.

## Using Nelson OS from Claude Code or Codex

After setup, the `nelson-os` MCP server provides these tools: `get_briefing`, `list_projects`, `get_project`, `search`, `read_thread`, `list_records`, `ask_drawings`, `create_record`, `update_record`, `draft_email`, `local_requirements`. Example: "What's overdue on Fulton St?" or "Draft the RFI about the Unit 4 vanity width and attach the RFI form."
