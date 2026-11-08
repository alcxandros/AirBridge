'use strict';
// Maps a tap on the shared-screen video (fractions of the picture) to the
// helper's absolute coordinates: 0..65535 across the whole virtual desktop
// (all monitors), in physical pixels.

/** Union of rectangles {x, y, width, height}. */
function unionRect(rects) {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.width));
  const y1 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * @param {{x:number,y:number}} tap       fractions 0..1 of the shared picture
 * @param {{x,y,width,height}} display    shared display, physical pixels
 * @param {{x,y,width,height}} virtual    whole virtual desktop, physical pixels
 * @returns {[number, number]}            helper "a" command coordinates
 */
function tapToAbsolute(tap, display, virtual) {
  const px = display.x + Math.min(Math.max(tap.x, 0), 1) * (display.width - 1);
  const py = display.y + Math.min(Math.max(tap.y, 0), 1) * (display.height - 1);
  const ax = Math.round(((px - virtual.x) * 65535) / Math.max(virtual.width - 1, 1));
  const ay = Math.round(((py - virtual.y) * 65535) / Math.max(virtual.height - 1, 1));
  return [Math.min(Math.max(ax, 0), 65535), Math.min(Math.max(ay, 0), 65535)];
}

module.exports = { tapToAbsolute, unionRect };
