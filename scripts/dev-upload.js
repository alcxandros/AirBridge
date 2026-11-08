// Runs only the phone upload page, for working on it in a browser:
//   node scripts/dev-upload.js  ->  http://localhost:8799/?t=dev
'use strict';
const os = require('os');
const path = require('path');
const { UploadServer } = require('../src/uploadServer');

const dir = path.join(os.tmpdir(), 'airbridge-dev-uploads');
const srv = new UploadServer({ getUploadDir: () => dir, isEnabled: () => true, deviceName: os.hostname() });
srv.token = 'dev';
srv.on('file', (f) => console.log('received', f.name, f.bytes, 'bytes'));
srv.start(8799, '127.0.0.1').then((p) => console.log(`upload page: http://localhost:${p}/?t=dev  (saving to ${dir})`));
