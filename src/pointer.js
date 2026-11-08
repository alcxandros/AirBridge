'use strict';
// Maps a tap on the shared-screen video (fractions of the picture) to a helper
// "p" command. The helper is DPI-aware and resolves the monitor itself (from a
// point inside it), so the click lands on the right physical pixel even when
// monitors use different Windows scaling.

const clamp01 = (v) => Math.min(Math.max(Number(v) || 0, 0), 1);

/**
 * @param {{x:number,y:number}} tap     fractions 0..1 of the shared picture
 * @param {{x,y,width,height}} display  shared display, physical pixels (approximate is fine)
 * @returns {string}                    "p <fx> <fy> <hintX> <hintY>"
 */
function tapCommand(tap, display) {
  // The display's centre: always inside the right monitor, even if Electron's
  // DIP->physical conversion is off by a pixel or two at the edges.
  const hx = Math.round(display.x + display.width / 2);
  const hy = Math.round(display.y + display.height / 2);
  return `p ${clamp01(tap.x).toFixed(5)} ${clamp01(tap.y).toFixed(5)} ${hx} ${hy}`;
}

module.exports = { tapCommand };
