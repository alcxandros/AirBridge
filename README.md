# AirBridge

Free, open-source alternative to paid "AirPlay to PC" apps. Two features:

1. **Screen mirroring and audio from iPhone, iPad and Mac.** Your PC shows up in
   Control Centre → *Screen Mirroring*, just like an Apple TV.
2. **Send files from any phone.** Scan a QR code and pick photos or files. They land
   in a folder on your PC. Nothing to install on the phone, and it works on iOS and Android.

Windows 10/11 (x64) is the main target. The app shell also runs on macOS and Linux
if `uxplay` is installed there (for example `brew install uxplay` or `apt install uxplay`).

## How it works

```
 iPhone ──AirPlay (mDNS + RAOP/mirroring)──▶ uxplay.exe ──GStreamer──▶ D3D12 window + WASAPI audio
   │                                            ▲  supervised by
   │                                            │
   └──HTTP upload (page from QR code)──▶ AirBridge (Electron) ──▶ chosen folder
```

- **Receiver engine: [UxPlay](https://github.com/FDH2/UxPlay)** (GPL-3.0), built from
  source and bundled with a trimmed GStreamer runtime. UxPlay 1.74 has its own
  mDNS responder, so **Apple Bonjour isn't needed**. AirBridge starts and stops it,
  restarts it after a crash, and passes the settings through (`-n <name> -nh -p 7100
  -vs d3d12videosink -as wasapisink`, plus `-pin`, `-fs`, `-h265` when enabled). A
  persistent key (`-key`) lets iOS remember the receiver.
- **File drop:** a small HTTP server in the Electron main process (`src/uploadServer.js`).
  The QR code holds the PC's LAN address and a random token. Uploads stream to disk.
  Names are sanitised, are never overwritten (`photo (1).jpg`), and are capped in
  size (8 GB by default). **New link** in the app invalidates the old QR code.
- **Firewall:** the installer adds inbound *Private*-profile rules for `uxplay.exe`
  and `AirBridge.exe` and removes them on uninstall. If your network is set to
  *Public*, the app shows a banner, because Windows blocks discovery there.

### Sound options

- **Play on this PC** (default): audio goes through the PC's default output.
- **Mute:** the PC accepts the audio but doesn't play it. iOS still sends it, so the
  phone is silent too.
- **Keep on the phone:** AirBridge advertises no audio support (`-noaudiofeat`, from
  `patches/0001-noaudiofeat.patch`), so iOS keeps playing sound on the phone while
  the picture goes to the PC. Handy when your headset is plugged into the PC. Tested
  on an iPhone (November 2026). This relies on undocumented iOS behaviour, so a future
  iOS update could change it. Start mirroring again after switching modes.

### Not included

- **AirDrop** is out of scope. It's a closed protocol that runs over Apple's AWDL
  Wi-Fi mode, which PC Wi-Fi adapters can't speak. The QR page is the cross-platform
  substitute.
- YouTube-style "AirPlay video" (HLS URL casting) isn't bundled yet. That needs
  GStreamer's HTTP/TLS plugins. Mirroring and audio streaming work.

## Use it

1. Install `AirBridge Setup x.y.z.exe` from `dist/` (it asks for admin rights to add
   the firewall rules). It isn't code-signed yet, so SmartScreen shows a warning:
   choose *More info → Run anyway*.
2. Keep the PC and phone on the same Wi-Fi, and set that network to **Private** in Windows.
3. iPhone: Control Centre → Screen Mirroring → pick your PC. Close the app window to
   keep it running in the tray.
4. Files: scan the QR code in the app with the phone camera, choose files, tap **Send**.

## Build from source (Windows)

Prerequisites: Node.js 20+, Git, and [MSYS2](https://www.msys2.org) (`winget install MSYS2.MSYS2`).

```powershell
npm install
npm run build:uxplay   # builds UxPlay in MSYS2 UCRT64 → vendor/uxplay (~10 min first time)
npm start              # run the app in development
npm test               # upload server + argument tests
npm run dist           # NSIS installer → dist/
```

`scripts/build-uxplay.sh` pins the UxPlay commit (`UXPLAY_REF`), installs the MSYS2
packages, builds with CMake/Ninja, copies only the GStreamer plugins UxPlay uses,
collects their DLL dependencies with `ntldd`, and copies the licence files.

### Troubleshooting

- **PC doesn't appear on the iPhone:** check the network is Private. Look for client
  isolation on guest Wi-Fi, a VPN on either device, or third-party firewalls. The **Log**
  section in the app shows UxPlay's output.
- **Black or stuttering video on old GPUs:** turn off 4K/HEVC.
- **Phone can't open the QR link:** pick the right adapter in the **Network** list
  (virtual adapters from Hyper-V or WSL are listed last).

## Licence

GPL-3.0-or-later, because AirBridge ships UxPlay (GPL-3.0). See `LICENSE` and
`THIRD_PARTY_NOTICES.md`. AirBridge is an independent project. It isn't affiliated
with Apple or with any commercial AirPlay receiver, and contains no code from them.
