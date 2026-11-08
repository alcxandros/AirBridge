// airbridge-helper.exe — small Windows helper for AirBridge (GPL-3.0-or-later).
//
//   airbridge-helper audio     list active audio outputs: "<*| >\t<id>\t<name>" per line
//                              ('*' marks the default device; id is IMMDevice::GetId,
//                              which is what GStreamer's wasapisink "device" expects)
//   airbridge-helper windows <pid>  list that process's visible windows (for screenshots)
//   airbridge-helper loopback [mute]  stream system sound as float32 stereo (see loopback())
//   airbridge-helper sleep     put the PC to sleep (never hibernate)
//   airbridge-helper input     read input commands from stdin, one per line:
//       m <dx> <dy>            relative mouse move
//       a <x> <y>              absolute move on the virtual desktop (0..65535 each)
//       p <fx> <fy> <hx> <hy>  move to fraction fx,fy (0..1) of the monitor containing
//                              physical point hx,hy (used for taps on the shared screen)
//       d <l|r|m> / u <l|r|m>  button down / up
//       c <l|r|m>              click
//       w <n> / h <n>          vertical / horizontal wheel (120 = one notch)
//       t <utf-8 text>         type text
//       k <name>               press a named key (see KEYS below)

#define WIN32_LEAN_AND_MEAN
#define INITGUID
#include <windows.h>
#include <mmdeviceapi.h>
#include <functiondiscoverykeys_devpkey.h>
#include <audioclient.h>
#include <endpointvolume.h>
#include <powrprof.h>
#include <fcntl.h>
#include <io.h>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

static std::string narrow(const wchar_t *w) {
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n - 1 : 0, '\0');
  if (n > 1) WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, nullptr, nullptr);
  return s;
}

static int listAudio() {
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 1;
  IMMDeviceEnumerator *en = nullptr;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void **)&en))) return 1;

  std::wstring defId;
  IMMDevice *def = nullptr;
  if (SUCCEEDED(en->GetDefaultAudioEndpoint(eRender, eConsole, &def))) {
    LPWSTR id = nullptr;
    if (SUCCEEDED(def->GetId(&id))) { defId = id; CoTaskMemFree(id); }
    def->Release();
  }

  IMMDeviceCollection *col = nullptr;
  if (FAILED(en->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &col))) return 1;
  UINT count = 0;
  col->GetCount(&count);
  for (UINT i = 0; i < count; i++) {
    IMMDevice *dev = nullptr;
    if (FAILED(col->Item(i, &dev))) continue;
    LPWSTR id = nullptr;
    dev->GetId(&id);
    IPropertyStore *props = nullptr;
    std::string name = "Unknown device";
    if (SUCCEEDED(dev->OpenPropertyStore(STGM_READ, &props))) {
      PROPVARIANT v;
      PropVariantInit(&v);
      if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR) name = narrow(v.pwszVal);
      PropVariantClear(&v);
      props->Release();
    }
    if (id) {
      printf("%s\t%s\t%s\n", defId == id ? "*" : " ", narrow(id).c_str(), name.c_str());
      CoTaskMemFree(id);
    }
    dev->Release();
  }
  col->Release();
  en->Release();
  CoUninitialize();
  return 0;
}

// Reports blocked input (e.g. a UAC prompt or an elevated window has focus) on stderr.
static void send(INPUT *in, UINT n) {
  if (SendInput(n, in, sizeof(INPUT)) != n) fprintf(stderr, "SendInput failed: %lu\n", GetLastError());
  else if (getenv("AIRBRIDGE_HELPER_VERBOSE")) fprintf(stderr, "ok %u\n", n);
}

static void mouseFlags(DWORD flags, LONG data = 0, LONG dx = 0, LONG dy = 0) {
  INPUT in = {};
  in.type = INPUT_MOUSE;
  in.mi.dwFlags = flags;
  in.mi.mouseData = (DWORD)data;
  in.mi.dx = dx;
  in.mi.dy = dy;
  send(&in, 1);
}

static DWORD buttonFlag(char b, bool down) {
  switch (b) {
    case 'r': return down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
    case 'm': return down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
    default: return down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
  }
}

static void vkey(WORD vk) {
  INPUT in[2] = {};
  in[0].type = in[1].type = INPUT_KEYBOARD;
  in[0].ki.wVk = in[1].ki.wVk = vk;
  in[1].ki.dwFlags = KEYEVENTF_KEYUP;
  // Arrow/navigation keys need the extended flag to behave like the real keys.
  if ((vk >= VK_PRIOR && vk <= VK_DOWN) || vk == VK_DELETE || vk == VK_INSERT) {
    in[0].ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
    in[1].ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
  }
  send(in, 2);
}

static void typeText(const char *utf8) {
  int n = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, nullptr, 0);
  if (n <= 1) return;
  std::wstring w(n - 1, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, utf8, -1, &w[0], n);
  for (wchar_t ch : w) {
    if (ch == L'\n') { vkey(VK_RETURN); continue; }
    INPUT in[2] = {};
    in[0].type = in[1].type = INPUT_KEYBOARD;
    in[0].ki.wScan = in[1].ki.wScan = ch;
    in[0].ki.dwFlags = KEYEVENTF_UNICODE;
    in[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
    send(in, 2);
  }
}

static const struct { const char *name; WORD vk; } KEYS[] = {
  {"enter", VK_RETURN}, {"backspace", VK_BACK}, {"tab", VK_TAB}, {"esc", VK_ESCAPE},
  {"space", VK_SPACE}, {"delete", VK_DELETE}, {"left", VK_LEFT}, {"right", VK_RIGHT},
  {"up", VK_UP}, {"down", VK_DOWN}, {"home", VK_HOME}, {"end", VK_END},
  {"pageup", VK_PRIOR}, {"pagedown", VK_NEXT}, {"win", VK_LWIN},
  {"volup", VK_VOLUME_UP}, {"voldown", VK_VOLUME_DOWN}, {"mute", VK_VOLUME_MUTE},
  {"playpause", VK_MEDIA_PLAY_PAUSE}, {"next", VK_MEDIA_NEXT_TRACK}, {"prev", VK_MEDIA_PREV_TRACK},
  {"f11", VK_F11}, {"f5", VK_F5},
};

static int inputLoop() {
  // Work in physical pixels. Without this, Windows maps positions through a
  // scaled "virtual" desktop when monitors use different scaling, and taps
  // from the phone land in the wrong place.
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  char line[8192];
  while (fgets(line, sizeof line, stdin)) {
    size_t len = strlen(line);
    while (len && (line[len - 1] == '\n' || line[len - 1] == '\r')) line[--len] = 0;
    if (len < 1) continue;
    char cmd = line[0];
    const char *arg = len > 2 ? line + 2 : "";
    switch (cmd) {
      case 'm': {
        long dx = 0, dy = 0;
        if (sscanf(arg, "%ld %ld", &dx, &dy) == 2) mouseFlags(MOUSEEVENTF_MOVE, 0, dx, dy);
        break;
      }
      case 'a': {
        // Absolute position on the virtual desktop, 0..65535 on each axis.
        long x = 0, y = 0;
        if (sscanf(arg, "%ld %ld", &x, &y) == 2 && x >= 0 && x <= 65535 && y >= 0 && y <= 65535)
          mouseFlags(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, 0, x, y);
        break;
      }
      case 'p': {
        // Fraction of a monitor (found from a point inside it) -> physical pixel.
        double fx = 0, fy = 0;
        long hx = 0, hy = 0;
        if (sscanf(arg, "%lf %lf %ld %ld", &fx, &fy, &hx, &hy) != 4) break;
        fx = fx < 0 ? 0 : fx > 1 ? 1 : fx;
        fy = fy < 0 ? 0 : fy > 1 ? 1 : fy;
        MONITORINFO mi = {sizeof mi};
        if (!GetMonitorInfoW(MonitorFromPoint({hx, hy}, MONITOR_DEFAULTTONEAREST), &mi)) break;
        const RECT &r = mi.rcMonitor;
        int x = r.left + (int)(fx * (r.right - r.left - 1) + 0.5);
        int y = r.top + (int)(fy * (r.bottom - r.top - 1) + 0.5);
        if (!SetCursorPos(x, y)) fprintf(stderr, "SetCursorPos failed: %lu\n", GetLastError());
        else if (getenv("AIRBRIDGE_HELPER_VERBOSE")) fprintf(stderr, "cursor %d %d\n", x, y);
        break;
      }
      case 'd': mouseFlags(buttonFlag(arg[0], true)); break;
      case 'u': mouseFlags(buttonFlag(arg[0], false)); break;
      case 'c': mouseFlags(buttonFlag(arg[0], true)); mouseFlags(buttonFlag(arg[0], false)); break;
      case 'w': mouseFlags(MOUSEEVENTF_WHEEL, atol(arg)); break;
      case 'h': mouseFlags(MOUSEEVENTF_HWHEEL, atol(arg)); break;
      case 't': typeText(arg); break;
      case 'k':
        for (auto &k : KEYS)
          if (!strcmp(k.name, arg)) { vkey(k.vk); break; }
        break;
    }
  }
  return 0;
}

// Visible top-level windows of a process: "<hwnd>\t<client w>\t<client h>\t<class>"
// (used to find UxPlay's mirror window for screenshots).
static BOOL CALLBACK enumWin(HWND h, LPARAM pid) {
  DWORD owner = 0;
  GetWindowThreadProcessId(h, &owner);
  if (owner != (DWORD)pid || !IsWindowVisible(h)) return TRUE;
  RECT r;
  GetClientRect(h, &r);
  char cls[128] = "";
  GetClassNameA(h, cls, sizeof cls);
  printf("%llu\t%ld\t%ld\t%s\n", (unsigned long long)(ULONG_PTR)h, r.right - r.left, r.bottom - r.top, cls);
  return TRUE;
}

// System sound capture for "share PC screen to phone". Records what the default
// output device plays (WASAPI loopback, in the device's own mix format, so it
// works with drivers that reject Chromium's requested format) and writes
//   "fmt <rate> 2\n" then raw little-endian float32 stereo frames
// to stdout until stdin closes. With "mute", the PC's speakers are muted while
// it runs (loopback is taken before the endpoint volume, so the phone still gets
// sound) and the previous mute state is restored on exit.
static volatile LONG g_stop = 0;
static DWORD WINAPI stdinWatch(LPVOID) {
  char buf[256];
  while (fgets(buf, sizeof buf, stdin)) {}
  InterlockedExchange(&g_stop, 1);
  return 0;
}
static BOOL WINAPI ctrlHandler(DWORD) {
  InterlockedExchange(&g_stop, 1);
  return TRUE;
}

static float sampleAt(const BYTE *p, const WAVEFORMATEX *wf, bool isFloat) {
  switch (wf->wBitsPerSample) {
    case 32: return isFloat ? *(const float *)p : (float)(*(const int32_t *)p / 2147483648.0);
    case 24: { int32_t v = (int32_t)((p[0] << 8) | (p[1] << 16) | (p[2] << 24)); return (float)(v / 2147483648.0); }
    case 16: return *(const int16_t *)p / 32768.0f;
    case 8: return (p[0] - 128) / 128.0f;
  }
  return 0;
}

static int loopback(bool mute) {
  _setmode(_fileno(stdout), _O_BINARY);
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 1;
  IMMDeviceEnumerator *en = nullptr;
  IMMDevice *dev = nullptr;
  IAudioClient *client = nullptr;
  IAudioCaptureClient *cap = nullptr;
  IAudioEndpointVolume *vol = nullptr;
  WAVEFORMATEX *wf = nullptr;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void **)&en);
  if (SUCCEEDED(hr)) hr = en->GetDefaultAudioEndpoint(eRender, eConsole, &dev);
  if (SUCCEEDED(hr)) hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void **)&client);
  if (SUCCEEDED(hr)) hr = client->GetMixFormat(&wf);
  if (SUCCEEDED(hr)) hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 200 * 10000, 0, wf, nullptr);
  if (SUCCEEDED(hr)) hr = client->GetService(__uuidof(IAudioCaptureClient), (void **)&cap);
  if (FAILED(hr)) {
    fprintf(stderr, "loopback failed: 0x%08lx\n", (unsigned long)hr);
    return 1;
  }
  bool isFloat = wf->wFormatTag == WAVE_FORMAT_IEEE_FLOAT ||
                 (wf->wFormatTag == WAVE_FORMAT_EXTENSIBLE && ((WAVEFORMATEXTENSIBLE *)wf)->SubFormat.Data1 == WAVE_FORMAT_IEEE_FLOAT);  // KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
  const int ch = wf->nChannels, bytes = wf->wBitsPerSample / 8;

  BOOL wasMuted = FALSE;
  if (mute && SUCCEEDED(dev->Activate(__uuidof(IAudioEndpointVolume), CLSCTX_ALL, nullptr, (void **)&vol))) {
    vol->GetMute(&wasMuted);
    vol->SetMute(TRUE, nullptr);
  }
  SetConsoleCtrlHandler(ctrlHandler, TRUE);
  CreateThread(nullptr, 0, stdinWatch, nullptr, 0, nullptr);

  printf("fmt %lu 2\n", (unsigned long)wf->nSamplesPerSec);
  fflush(stdout);
  client->Start();
  std::vector<float> out;
  while (!g_stop) {
    Sleep(10);
    UINT32 packet = 0;
    while (!g_stop && SUCCEEDED(cap->GetNextPacketSize(&packet)) && packet) {
      BYTE *data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
      out.assign((size_t)frames * 2, 0.0f);
      if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
        for (UINT32 i = 0; i < frames; i++) {
          const BYTE *f = data + (size_t)i * wf->nBlockAlign;
          float l = sampleAt(f, wf, isFloat);
          float r = ch > 1 ? sampleAt(f + bytes, wf, isFloat) : l;
          out[i * 2] = l;
          out[i * 2 + 1] = r;
        }
      }
      cap->ReleaseBuffer(frames);
      if (fwrite(out.data(), sizeof(float), out.size(), stdout) != out.size()) InterlockedExchange(&g_stop, 1);
    }
  }
  client->Stop();
  if (vol) {
    vol->SetMute(wasMuted, nullptr);
    vol->Release();
  }
  cap->Release();
  client->Release();
  CoTaskMemFree(wf);
  dev->Release();
  en->Release();
  return 0;
}

int main(int argc, char **argv) {
  setvbuf(stdout, nullptr, _IONBF, 0);
  // SetSuspendState(FALSE, ...) sleeps; "rundll32 powrprof.dll,SetSuspendState" can hibernate instead.
  if (argc >= 2 && !strcmp(argv[1], "sleep")) return SetSuspendState(FALSE, FALSE, FALSE) ? 0 : 1;
  if (argc >= 2 && !strcmp(argv[1], "loopback")) return loopback(argc >= 3 && !strcmp(argv[2], "mute"));
  if (argc >= 3 && !strcmp(argv[1], "windows")) return EnumWindows(enumWin, (LPARAM)strtoul(argv[2], nullptr, 10)) ? 0 : 1;
  if (argc >= 2 && !strcmp(argv[1], "audio")) return listAudio();
  if (argc >= 2 && !strcmp(argv[1], "input")) return inputLoop();
  fprintf(stderr, "usage: airbridge-helper audio | input\n");
  return 2;
}
