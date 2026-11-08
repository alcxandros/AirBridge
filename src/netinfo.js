'use strict';
const os = require('os');

// Addresses a phone can use to reach this PC: private IPv4 on the local
// network, plus the Tailscale address (100.64.0.0/10) when Tailscale is running,
// which also works away from home. Order: real LAN adapters, then Tailscale,
// then other virtual adapters (Hyper-V, WSL, VirtualBox, VPNs).
function lanAddresses(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const tailscale = isTailscale(a.address);
      if (!tailscale && !isPrivate(a.address)) continue;
      const virtual = !tailscale && /vethernet|virtual|vmware|vbox|hyper-v|wsl|loopback|tailscale|zerotier|vpn|tap/i.test(name);
      out.push({ name: tailscale ? 'Tailscale' : name, address: a.address, virtual, tailscale });
    }
  }
  const group = (a) => (a.tailscale ? 1 : a.virtual ? 2 : 0);
  out.sort((x, y) => group(x) - group(y) || rank(x.address) - rank(y.address));
  return out;
}

/** Tailscale hands out addresses from the carrier-grade NAT range 100.64.0.0/10. */
function isTailscale(ip) {
  const [a, b] = String(ip).split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
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
      // Tailscale's adapter is often Public; AirBridge has its own firewall rule for it.
      ['-NoProfile', '-NonInteractive', '-Command', "Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' -and $_.InterfaceAlias -notlike '*Tailscale*' } | ForEach-Object Name"],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => resolve(err ? [] : stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)),
    );
  });
}

module.exports = { lanAddresses, isPrivate, isTailscale, publicNetworks };
