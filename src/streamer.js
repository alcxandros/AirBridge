'use strict';
// Streamer mode helpers.

/** True if `tasklist /FO CSV /NH` output lists OBS Studio (obs64.exe, obs32.exe or obs.exe). */
function obsInTasklist(csv) {
  return /^"obs(64|32)?\.exe"/im.test(String(csv || ''));
}

module.exports = { obsInTasklist };
