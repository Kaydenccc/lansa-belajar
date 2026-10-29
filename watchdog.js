'use strict';
// Dijalankan sebagai proses terpisah (detached) oleh Lensa.
// Pantau apakah proses Lensa hidup; restart otomatis jika mati sebelum waktunya.
// Argumen: watchdog.js <userData-path>
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const appDir = __dirname;
const dataDir = process.argv[2];
if (!dataDir) process.exit(1);

const pidFile  = path.join(dataDir, 'lensa.pid');
const quitFile = path.join(dataDir, 'lensa.quit');
const wdLog    = path.join(dataDir, 'watchdog.log');

function log(msg) {
  try { fs.appendFileSync(wdLog, `${new Date().toISOString()} ${msg}\n`); } catch {}
}

function readPid() {
  try { return parseInt(fs.readFileSync(pidFile, 'utf8'), 10); } catch { return 0; }
}

function alive(pid) {
  if (!pid || isNaN(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

let restarting = false;

function restart() {
  if (restarting) return;
  restarting = true;
  log('Lensa tidak terdeteksi, membuka kembali...');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(npm, ['start'], {
    cwd: appDir,
    detached: true,
    stdio: 'ignore',
    env,
    windowsHide: true,
  });
  child.unref();
  setTimeout(() => { restarting = false; }, 10000);
}

log('Watchdog mulai, memantau PID di ' + pidFile);

setInterval(() => {
  if (fs.existsSync(quitFile)) {
    log('Lensa keluar normal, watchdog berhenti.');
    try { fs.unlinkSync(quitFile); } catch {}
    process.exit(0);
  }
  const pid = readPid();
  if (!alive(pid)) restart();
}, 3000);
