import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const failure = () => Object.assign(new Error('本机密钥保险箱不可用。请使用保存密钥时的 Windows 账户启动应用；原密钥文件已保留。'), { status: 503 });
// Secrets travel through anonymous pipes, never command arguments or plaintext temporary files.
export function dpapi(action, value) {
  if (process.platform !== 'win32') return Promise.reject(failure());
  const operation = action === 'protect' ? 'Protect' : 'Unprotect';
  const script = `Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
try {
  $result = [Security.Cryptography.ProtectedData]::${operation}($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($result))
} catch { exit 1 } finally { [Array]::Clear($bytes, 0, $bytes.Length) }`;
  return new Promise((accept, reject) => {
    const child = spawn(resolve(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(failure()); }, 15000);
    child.stdout.on('data', data => { output += data; if (output.length > 65536) child.kill(); });
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(failure()); });
    child.on('close', code => { clearTimeout(timer); code === 0 && /^[A-Za-z0-9+/=]+$/.test(output) ? accept(Buffer.from(output, 'base64')) : reject(failure()); });
    child.stdin.end(Buffer.from(value).toString('base64'));
  });
}
export function atomicJSON(file, data) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try { writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); renameSync(temp, file); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}
export function createVault(file, { transform = dpapi, supported = process.platform === 'win32' } = {}) {
  let writing = false;
  const read = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw failure(); } };
  return {
    status() {
      try { const item = read(); return { supported, configured: !!item, suffix: item?.suffix || '', protection: 'Windows DPAPI · 当前用户', problem: '' }; }
      catch { return { supported, configured: false, suffix: '', protection: 'Windows DPAPI · 当前用户', problem: '密钥文件无法读取，请检查本机文件或删除后重新配置。' }; }
    },
    async getKey() {
      const item = read(); if (!item) return '';
      if (!supported || item.version !== 1 || item.protection !== 'dpapi-current-user') throw failure();
      const bytes = await transform('unprotect', Buffer.from(item.ciphertext, 'base64'));
      try { return bytes.toString('utf8'); } finally { bytes.fill(0); }
    },
    async save(apiKey) {
      if (!supported) throw failure();
      if (writing) throw Object.assign(new Error('密钥正在更新，请稍后重试'), { status: 409 });
      writing = true; const bytes = Buffer.from(apiKey, 'utf8');
      try { const encrypted = await transform('protect', bytes); atomicJSON(file, { version: 1, protection: 'dpapi-current-user', suffix: apiKey.slice(-4), ciphertext: encrypted.toString('base64') }); }
      finally { bytes.fill(0); writing = false; }
    },
    remove() { if (writing) throw Object.assign(new Error('密钥正在更新，请稍后重试'), { status: 409 }); try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw failure(); } },
  };
}
