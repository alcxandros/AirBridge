# AirBridge

Free, open-source alternative to paid "AirPlay to PC" apps, plus a phone ↔ PC bridge
that needs nothing installed on the phone.

1. **Screen mirroring and audio from iPhone, iPad and Mac.** Your PC shows up in
   Control Centre → *Screen Mirroring*, just like an Apple TV. You can choose where the
   sound goes (see below), take screenshots, record sessions to MP4, and add the mirror
   to OBS in one click.
2. **Reverse mirroring: the PC screen on the phone.** Turn on **Share screen to phone**
   and the phone page's **Screen & remote** tab shows the PC's screen live. PC sound can come
   along. Pinch to zoom in, pick which monitor to show from the phone, and with remote
   control on, tap, drag and long-press the picture to click, drag and right-click on the PC.
3. **Phone page from a QR code** (iPhone and Android, in the browser). You scan the code
   once: after that the phone is remembered and can live on its Home Screen like an app.
   HTTPS is optional. The page has three tabs:
   - **Files:** photos and files from the phone land in a folder on the PC, and files
     you drop into AirBridge on the PC can be downloaded on the phone.
   - **Screen & remote:** the PC's screen live (when sharing is on), with a trackpad,
     keyboard and media keys underneath, so you can see what you're controlling. Remote
     control is off by default.
   - **Clipboard & links:** text from the phone is copied on the PC, you can push the
     PC's clipboard to the phone, and a link from the phone opens in the PC's browser.
   A dot on Files or Clipboard & links means something new arrived from the PC.
   **Away from home:** with [Tailscale](https://tailscale.com) on the PC and phone, pick the
   Tailscale address in AirBridge and it works from anywhere.
4. **PC power from the phone:** lock, sleep, restart or shut down (restart and shut down
   wait 20 seconds and can be cancelled). Needs remote control.
5. **Looks:** light, dark or system theme and five accent colours on the PC; the phone page
   follows them, and each phone can override the theme and set trackpad speed and scroll
   direction (gear icon).

Windows 10/11 (x64) is the main target. The app shell also runs on macOS and Linux
if `uxplay` is installed there (for example `brew install uxplay` or `apt install uxplay`).
On those systems the remote control and output picker aren't available.

## How it works

```
 iPhone ──AirPlay (mDNS + RAOP/mirroring)──▶ uxplay.exe ──GStreamer──▶ D3D12 window + WASAPI audio
   │                                            ▲  supervised by              │
   │                                            │                             └─▶ OBS (Window Capture)
   └──HTTP + WebSocket (page from QR code)──▶ AirBridge (Electron)
                                                ├─▶ upload folder / shared files / clipboard / browser
                                                └─▶ airbridge-helper.exe (SendInput: mouse, keys)
```

- **Receiver engine: [UxPlay](https://github.com/FDH2/UxPlay)** (GPL-3.0), built from
  source and bundled with a trimmed GStreamer runtime. UxPlay 1.74 has its own
  mDNS responder, so **Apple Bonjour isn't needed**. AirBridge starts and stops it,
  restarts it after a crash, and passes the settings through (`-n <name> -nh -p 7100
  -vs d3d12videosink -as wasapisink`, plus `-pin`, `-fs`, `-h265`, `-nc` when enabled).
  A persistent key (`-key`) lets iOS remember the receiver.
- **Phone server** (`src/phoneServer.js`): HTTP and a WebSocket in the Electron main
  process. The QR code holds the PC's LAN address and a random token, and every request
  and WebSocket needs that token. **New link** in the app invalidates the old QR code
  and disconnects any open phone pages. Uploads stream to disk. Names are sanitised,
  are never overwritten (`photo (1).jpg`), and are capped in size (8 GB by default). The
  phone can download only files you explicitly shared, and it never sees their PC paths.
  Only `http(s)` links are opened.
- **Native helper** (`native/helper.cpp` → `airbridge-helper.exe`): lists audio outputs
  and injects mouse and keyboard input with `SendInput`. The phone page sends simple
  messages, and the server checks and converts them into a small fixed set of commands
  (moves, clicks, scroll, text, and a list of allowed keys). Remote input is only
  accepted while **Allow phone to control mouse & keyboard** is on. If the phone
  disconnects, any button it was holding is released. Windows itself blocks injected
  input into elevated windows and UAC prompts.
- **Firewall:** the installer adds inbound *Private*-profile rules for `uxplay.exe`
  and `AirBridge.exe` and removes them on uninstall. If your network is set to
  *Public*, the app shows a banner, because Windows blocks discovery there.

### Sound options

- **Play on this PC** (default): audio goes to the output picked in **Play through**
  (Windows default, or a specific device such as speakers instead of your headset).
- **Mute:** the PC accepts the audio but doesn't play it. iOS still sends it, so the
  phone is silent too.
- **Keep on the phone:** AirBridge advertises no audio support (`-noaudiofeat`, from
  `patches/0001-noaudiofeat.patch`), so iOS keeps playing sound on the phone while
  the picture goes to the PC. Handy when your headset is plugged into the PC. Tested
  on an iPhone (November 2026). This relies on undocumented iOS behaviour, so a future
  iOS update could change it. Start mirroring again after switching modes.

### Sharing the PC screen to the phone (reverse mirroring)

- **How it works:** a hidden window (`src/caster/`) captures the chosen display with
  `getDisplayMedia`. The main process picks the screen through
  `setDisplayMediaRequestHandler`, so no picker appears. It streams to each watching
  phone over **WebRTC**, preferring H.264, which phones decode in hardware. The
  phone page's existing WebSocket carries the setup messages (`cast-*`). The PC sends the
  offer, and only well-formed answers and ICE candidates are relayed. It's LAN-only:
  there are no STUN or TURN servers, and it uses real host addresses.
- **Settings:**
  - **Screen:** which monitor to share. It's captured at its native resolution, up to 4K.
  - **PC sound:** don't send, play on the PC and the phone, or *phone only*. Phone
    only mutes the PC while sharing. The sound is captured by `airbridge-helper.exe`
    (WASAPI loopback in the output device's own format, which some drivers need) and
    the PC's mute setting is put back when sharing stops.
  - **Picture:** *Sharp* is 30 fps and keeps text crisp. *Smooth* is 60 fps and is
    better for video and games.
- **Phone:** open the **Screen & remote** tab. **Sound on** is needed because browsers only play
  audio after a tap. **Fill screen** shows the picture edge to edge (turn the phone
  sideways). With **remote control** on, tap the picture to click at that spot,
  two-finger tap to right-click, and drag two fingers to scroll. The tap is mapped to
  the right monitor of a multi-monitor desktop (`src/pointer.js`).
- **Privacy:** sharing is **always off** when AirBridge starts. While it's on, a red
  banner in the app and the tray tooltip say so, and show how many phones are watching.
  **Stop sharing** closes the capture immediately. Only paired phones, or phones with
  the current QR link, can watch.
- The installer's firewall rule for `AirBridge.exe` allows UDP as well as TCP
  (Private networks only), because WebRTC needs UDP.

### Remembered phones and HTTPS

- **Pairing.** The QR link carries a short-lived *session* token. It changes when
  AirBridge restarts or you press **New link**. On first open, the page swaps it for
  the phone's own *device* token (`POST /api/pair`) and keeps that token in the address
  bar and in local storage. *Add to Home Screen* then saves a link that keeps working.
  The PC stores only SHA-256 hashes of device tokens. **Remembered phones** in the app
  lists them with "last seen", and **Remove** disconnects one immediately. **New link**
  only affects the QR code, not remembered phones.
- **HTTPS (optional).** AirBridge creates its own small certificate authority (CA)
  (`src/tls.js`). Its key is stored encrypted with Windows DPAPI. It issues a
  certificate for the PC's LAN addresses and `<pc-name>.local`, and serves the page over
  HTTPS on the next port (8766). The phone page shows the steps to install and trust
  the CA once. After that it switches to HTTPS by itself, which also enables
  **Send my phone's clipboard**. The CA is **name-constrained** to `10/8`, `172.16/12`,
  `192.168/16` and `.local`, so even a leaked CA key couldn't be used to impersonate a
  real website to the phone. On iPhone, set up HTTPS *before* adding the page to the
  Home Screen, because a Home Screen app can't move from the `http://` address to the
  `https://` one.
- The link uses the PC's IP address. If your router gives the PC a new address, scan
  the QR code again, or give the PC a fixed address (DHCP reservation) in your router.

### Screenshots and recording

- **Take screenshot** (in the app or the tray) saves a PNG of the mirror window to
  `Pictures\AirBridge`. It finds UxPlay's window through the helper and captures it with
  Electron's `desktopCapturer`, so the window must not be minimised.
- **Record sessions to video** passes `-mp4` to UxPlay. Each mirroring session becomes
  `Videos\AirBridge\AirBridge <date time>.<n>.<codecs>.mp4`. You can change the folder.
  UxPlay can only start recording when it launches, so switching this on or off
  restarts the receiver (the app asks first if a phone is mirroring). A small UxPlay
  patch (`patches/0002`) quotes the path so folders with spaces work.

### Tray and startup

- **Start AirBridge when I sign in to Windows** (installed app only) starts it hidden
  in the tray.
- The tray menu shows the mirroring status ("ready" or "connected to …"). From it you
  can turn mirroring on or off, take a screenshot, turn recording on or off, send the
  clipboard to the phone, re-copy recent text from the phone, open recent files, and
  open the QR code. `patches/0003` makes UxPlay log disconnects, so the status clears
  when the phone stops mirroring.

### Streaming in OBS

Open **Stream it in OBS** in the Screen mirroring card and click **Add to OBS**. AirBridge
connects to OBS's built-in WebSocket server and adds a *Window Capture* source called
"iPhone mirror (AirBridge)" to the current scene. The source matches `uxplay.exe` and
captures only the window's client area. AirBridge also turns on **Keep the mirror
window open between sessions** (`-nc`), so the source doesn't disappear when the phone
disconnects. You must first turn on OBS's WebSocket server under Tools → WebSocket
Server Settings. If it has a password, enter it once. AirBridge stores it encrypted
with Windows DPAPI through Electron `safeStorage`.

To set it up by hand instead: add a Window Capture source, pick `[uxplay.exe]: Direct3D12
Renderer`, set the capture method to *Windows 10 (1903 and up)*, and tick *Client area*.

### Not included

- **AirDrop** is out of scope. It's a closed protocol that runs over Apple's AWDL
  Wi-Fi mode, which PC Wi-Fi adapters can't speak. The phone page is the cross-platform
  substitute.
- YouTube-style "AirPlay video" (HLS URL casting) isn't bundled yet. That needs
  GStreamer's HTTP/TLS plugins. Mirroring and audio streaming work.
- Without the optional HTTPS setup, the phone page runs over plain HTTP on your LAN, so
  the phone's browser blocks some features. For example, the page can't read the
  phone's clipboard by itself, so you paste into the **Clipboard & links** tab.

## Use it

1. Download `AirBridge-Setup-x.y.z.exe` from the
   [latest release](https://github.com/alcxandros/airbridge/releases/latest) and run it
   (it asks for admin rights to add the firewall rules). It isn't code-signed yet, so
   SmartScreen shows a warning: choose *More info → Run anyway*. After that, AirBridge
   updates itself from GitHub Releases (turn this off under Screen mirroring).
2. Keep the PC and phone on the same Wi-Fi, and set that network to **Private** in Windows.
3. iPhone: Control Centre → Screen Mirroring → pick your PC. Close the app window to
   keep it running in the tray.
4. Phone ↔ PC: scan the QR code in the app with the phone camera, once. Optionally
   follow the on-page steps for HTTPS, then use Share → *Add to Home Screen* so it opens
   like an app.

## Build from source (Windows)

Prerequisites: Node.js 20+, Git, and [MSYS2](https://www.msys2.org) (`winget install MSYS2.MSYS2`).

```powershell
npm install
npm run build:native   # UxPlay → vendor/uxplay (~10 min first time) and helper → vendor/helper
npm start              # run the app in development
npm test               # phone server, settings, arguments, OBS protocol (mock server)
npm run dist           # NSIS installer → dist/
```

`scripts/build-uxplay.sh` pins the UxPlay commit (`UXPLAY_REF`), applies `patches/`,
installs the MSYS2 packages, builds with CMake/Ninja, copies only the GStreamer plugins
UxPlay uses, collects their DLL dependencies with `ntldd`, and copies the licence files.
`scripts/build-helper.sh` builds the helper as a static exe.

Development helpers:

- `node scripts/dev-upload.js` serves just the phone page at `http://localhost:8799/?t=dev`
  and logs every event, including remote input, without moving your mouse.
- `AIRBRIDGE_PROFILE=<folder>` runs a separate dev copy next to an installed AirBridge.
- `AIRBRIDGE_INPUT_LOG=<file>` logs remote input commands.

### Troubleshooting

- **PC doesn't appear on the iPhone:** check the network is Private. Look for client
  isolation on guest Wi-Fi, a VPN on either device, or third-party firewalls. The **Log**
  section in the app shows UxPlay's output.
- **Black or stuttering video on old GPUs:** turn off 4K/HEVC.
- **Phone can't open the QR link:** pick the right adapter in the **Network** list
  (virtual adapters from Hyper-V or WSL are listed last).
- **Remote doesn't move the mouse over one app:** that app is running as administrator,
  and Windows blocks input into it from normal programs.

## Licence

GPL-3.0-or-later, because AirBridge ships UxPlay (GPL-3.0). See `LICENSE` and
`THIRD_PARTY_NOTICES.md`. AirBridge is an independent project. It isn't affiliated
with Apple or with any commercial AirPlay receiver, and contains no code from them.
