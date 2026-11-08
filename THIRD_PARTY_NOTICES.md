# Third-party software in AirBridge

AirBridge is free software under the GNU General Public License v3.0 or later
(see `LICENSE`). Installers bundle these components, each under its own licence.
Full licence texts ship in `resources/uxplay/licenses/`.

| Component | Use | Licence | Source |
|---|---|---|---|
| UxPlay (FDH2/UxPlay, pinned commit in `resources/uxplay/UXPLAY_COMMIT`) | AirPlay mirroring and audio engine (`uxplay.exe`) | GPL-3.0; parts LGPL-2.1+ (mDNS, RAOP), MIT (llhttp) | https://github.com/FDH2/UxPlay |
| GStreamer + base/good/bad plugins | video/audio decoding and rendering | LGPL-2.1+ | https://gstreamer.freedesktop.org |
| gst-libav / FFmpeg | software decoders | LGPL-2.1+ | https://ffmpeg.org |
| libplist | Apple property-list parsing | LGPL-2.1+ | https://github.com/libimobiledevice/libplist |
| OpenSSL 3.x | cryptography | Apache-2.0 | https://www.openssl.org |
| GLib and other MSYS2 runtime DLLs | runtime libraries | various (see `licenses/`) | https://packages.msys2.org |
| Electron | desktop shell | MIT | https://www.electronjs.org |
| busboy | multipart upload parsing | MIT | https://github.com/mscdex/busboy |
| qrcode | QR code generation | MIT | https://github.com/soldair/node-qrcode |

**Source code offer.** Source for AirBridge is at https://github.com/alcxandros/airbridge.
UxPlay is modified by the patches in `patches/` (GPL-3.0), and
`scripts/build-uxplay.sh` rebuilds the exact UxPlay bundle from the upstream
sources and MSYS2 packages listed above.

AirPlay, iPhone and iPad are trademarks of Apple Inc. AirBridge is not affiliated
with or endorsed by Apple.
