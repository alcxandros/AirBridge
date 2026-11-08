'use strict';
const os = require('os');

// Private IPv4 addresses the phone can reach on the local network.
// Virtual adapters (Hyper-V, WSL, VirtualBox, VPNs) are ranked last.
function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (!isPrivate(a.address)) continue;
      const virtual = /vethernet|virtual|vmware|vbox|hyper-v|wsl|loopback|tailscale|zerotier|vpn|tap/i.test(name);
      out.push({ name, address: a.address, virtual });
    }
  }
  out.sort((x, y) => Number(x.virtual) - Number(y.virtual) || rank(x.address) - rank(y.address));
  return out;
}

function isPrivate(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Home routers almost always hand out 192.168.x.x, so prefer that range.
function rank(ip) {
  return ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2;
}

// Windows only: names of connected networks set to "Public", where the
// firewall blocks discovery. Resolves [] elsewhere or on any error.
function publicNetworks() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetConnectionProfile | Where-Object NetworkCategory -eq Public | ForEach-Object Name'],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => resolve(err ? [] : stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)),
    );
  });
}

module.exports = { lanAddresses, isPrivate, publicNetworks };
