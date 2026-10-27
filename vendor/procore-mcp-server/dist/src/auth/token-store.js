import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
const DEFAULT_TOKEN_DIR = join(homedir(), ".procore-mcp");
const DEFAULT_TOKEN_FILE = "tokens.json";
function getTokenPath() {
    const custom = process.env.PROCORE_TOKEN_PATH;
    if (custom)
        return custom;
    return join(DEFAULT_TOKEN_DIR, DEFAULT_TOKEN_FILE);
}
export function readTokens() {
    const tokenPath = getTokenPath();
    try {
        const raw = readFileSync(tokenPath, "utf8");
        const data = JSON.parse(raw);
        if (!data.access_token || !data.refresh_token || !data.expires_at) {
            return null;
        }
        return data;
    }
    catch {
        return null;
    }
}
export function writeTokens(tokens) {
    const tokenPath = getTokenPath();
    const dir = dirname(tokenPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Atomic write: write to temp file, then rename
    const tmpPath = tokenPath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(tokens, null, 2), {
        mode: 0o600,
    });
    renameSync(tmpPath, tokenPath);
}
export function isTokenExpired(tokens) {
    // 60-second buffer before actual expiry
    return Date.now() >= tokens.expires_at - 60_000;
}
export function tokensExist() {
    return readTokens() !== null;
}
