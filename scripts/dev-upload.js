// Runs only the phone page server, for working on it in a browser:
//   node scripts/dev-upload.js  ->  http://localhost:8799/?t=dev
// Shares this script itself for the Get tab and logs clipboard/link/remote events.
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const { PhoneServer } = require('../src/phoneServer');

const dir = path.join(os.tmpdir(), 'airbridge-dev-uploads');
const shared = [{ id: 'abcdef0123456789', path: __filename, name: 'dev-upload.js', size: fs.statSync(__filename).size }];
const srv = new PhoneServer({
  getUploadDir: () => dir,
  isEnabled: () => true,
  remoteEnabled: () => true,
  getShared: () => shared,
  getClip: () => ({ text: 'Hello from the PC clipboard', at: Date.now() }),
  deviceName: os.hostname(),
});
srv.token = 'dev';
srv.on('file', (f) => console.log('file', f.name, f.bytes));
srv.on('clipboard', (c) => console.log('clipboard', JSON.stringify(c.text)));
srv.on('link', (l) => console.log('link', l.url));
srv.on('input', (line) => console.log('input', line));
srv.on('clients', (n) => console.log('clients', n));
srv.start(8799, '127.0.0.1').then((p) => console.log(`phone page: http://localhost:${p}/?t=dev  (saving to ${dir})`));
