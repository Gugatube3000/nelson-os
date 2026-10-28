// Encrypted vault for OAuth tokens and API keys.
// The vault file is AES-256-GCM encrypted. Its key is protected by the operating system:
// Windows DPAPI (current user), macOS Keychain, or a 0600 key file on Linux.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA_DIR } from './paths.js';

const VAULT_FILE = path.join(DATA_DIR, 'vault.enc');
const KEY_FILE = path.join(DATA_DIR, 'vault.key');
const PLAIN_KEY_FILE = path.join(DATA_DIR, 'vault.key.plain');
const KEYCHAIN_SERVICE = 'NelsonOS';

let cachedKey = null;
export let protection = 'unknown';

// The server, CLI tools and another app instance may share this data folder.
// Serialize read-modify-write operations and always reread the encrypted file.
function withVaultLock(fn) {
  const lock = path.join(DATA_DIR, 'vault.lock');
  const owner = `${process.pid}:${crypto.randomBytes(8).toString('hex')}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeFileSync(fd, owner);
      fs.closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const pid = Number(fs.readFileSync(lock, 'utf8').split(':')[0]);
        if (pid > 0) {
          try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') { fs.unlinkSync(lock); continue; } }
        }
      } catch (e) { if (e.code === 'ENOENT') continue; }
      if (Date.now() >= deadline) throw new Error('Sign-in storage is busy. Try again in a moment.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); }
  finally {
    if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === owner) fs.unlinkSync(lock);
  }
}

function dpapi(mode, b64) {
  const op = mode === 'protect' ? 'Protect' : 'Unprotect';
  const script = `Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadToEnd().Trim(); ` +
    `$out = [Security.Cryptography.ProtectedData]::${op}([Convert]::FromBase64String($in), $null, 'CurrentUser'); ` +
    `[Convert]::ToBase64String($out)`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: b64, encoding: 'utf8', windowsHide: true, timeout: 20000,
  }).trim();
}

function loadKey() {
  if (cachedKey) return cachedKey;
  // A plain key file only exists if OS protection failed on first run; keep using it so the vault stays readable.
  if (fs.existsSync(PLAIN_KEY_FILE)) {
    cachedKey = Buffer.from(fs.readFileSync(PLAIN_KEY_FILE, 'utf8'), 'base64');
    protection = 'Local key file (owner-only permissions)';
    return cachedKey;
  }
  try {
    if (process.platform === 'win32') {
      if (fs.existsSync(KEY_FILE)) {
        cachedKey = Buffer.from(dpapi('unprotect', fs.readFileSync(KEY_FILE, 'utf8')), 'base64');
      } else {
        if (fs.existsSync(VAULT_FILE)) throw new Error('The encryption key for the saved sign-ins is missing. Restore the key from a backup.');
        const key = crypto.randomBytes(32);
        const protectedKey = dpapi('protect', key.toString('base64'));
        try { fs.writeFileSync(KEY_FILE, protectedKey, { flag: 'wx' }); cachedKey = key; }
        catch (err) {
          if (err.code !== 'EEXIST') throw err;
          cachedKey = Buffer.from(dpapi('unprotect', fs.readFileSync(KEY_FILE, 'utf8')), 'base64');
        }
      }
      protection = 'Windows DPAPI';
      return cachedKey;
    }
    if (process.platform === 'darwin') {
      try {
        const b64 = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'vault-key', '-w'], { encoding: 'utf8' }).trim();
        cachedKey = Buffer.from(b64, 'base64');
      } catch {
        cachedKey = crypto.randomBytes(32);
        execFileSync('security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', 'vault-key', '-w', cachedKey.toString('base64')]);
      }
      protection = 'macOS Keychain';
      return cachedKey;
    }
  } catch (err) {
    if (fs.existsSync(KEY_FILE) || fs.existsSync(VAULT_FILE)) {
      cachedKey = null;
      throw new Error('Cannot unlock saved sign-ins. Use the same operating-system account or restore the encryption key from a backup. The existing key has been preserved.', { cause: err });
    }
    console.warn('[vault] OS key protection unavailable, using local key file:', err.message);
  }
  if (fs.existsSync(VAULT_FILE)) throw new Error('The encryption key for saved sign-ins is missing. Restore it from a backup.');
  const key = crypto.randomBytes(32);
  try { fs.writeFileSync(PLAIN_KEY_FILE, key.toString('base64'), { mode: 0o600, flag: 'wx' }); cachedKey = key; }
  catch (err) {
    if (err.code !== 'EEXIST') throw err;
    cachedKey = Buffer.from(fs.readFileSync(PLAIN_KEY_FILE, 'utf8'), 'base64');
  }
  protection = 'Local key file (owner-only permissions)';
  return cachedKey;
}

function readVault() {
  if (!fs.existsSync(VAULT_FILE)) return {};
  const raw = Buffer.from(fs.readFileSync(VAULT_FILE, 'utf8'), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

function writeVault(vault) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(vault), 'utf8'), cipher.final()]);
  const tmp = VAULT_FILE + '.tmp';
  fs.writeFileSync(tmp, Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64'), { mode: 0o600 });
  fs.renameSync(tmp, VAULT_FILE);
}

export function getSecret(name) {
  return readVault()[name] ?? null;
}

export function setSecret(name, value) {
  return withVaultLock(() => {
  const vault = { ...readVault() };
  if (value === null || value === undefined) delete vault[name];
  else vault[name] = value;
  writeVault(vault);
  });
}

export function hasSecret(name) {
  return getSecret(name) != null;
}

export function vaultInfo() {
  loadKey();
  return { protection, file: VAULT_FILE };
}
