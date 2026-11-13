import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
// Rustup is commonly installed outside PATH on Windows.
const env = { ...process.env };
const cargoBin = join(env.USERPROFILE ?? env.HOME ?? '', '.cargo', 'bin');
const pathName = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
if (existsSync(cargoBin)) env[pathName] = `${cargoBin}${process.platform === 'win32' ? ';' : ':'}${env[pathName] ?? ''}`;
if (process.platform === 'win32' && !env.VCToolsInstallDir) {
  const vswhere = join(env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
  if (existsSync(vswhere)) {
    const install = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).trim();
    const setup = join(install, 'Common7/Tools/VsDevCmd.bat');
    if (install && existsSync(setup)) {
      const output = execFileSync(env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `call "${setup}" -no_logo -arch=x64 -host_arch=x64 >nul && set`], { encoding: 'utf8', env, windowsVerbatimArguments: true });
      for (const line of output.split(/\r?\n/)) {
        const at = line.indexOf('='); if (at <= 0) continue;
        const name = line.slice(0, at);
        const previous = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase());
        if (previous) delete env[previous];
        env[name] = line.slice(at + 1);
      }
    }
  }
}
const args = process.argv.slice(2);
let command = process.execPath, commandArgs = ['node_modules/@tauri-apps/cli/tauri.js', ...args];
if (['check', 'test'].includes(args[0])) { command = 'cargo'; commandArgs = [args[0], '--locked', '--manifest-path', 'src-tauri/Cargo.toml']; }
const child = spawn(command, commandArgs, { stdio: 'inherit', env });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
