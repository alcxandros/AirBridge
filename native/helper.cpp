// airbridge-helper.exe — small Windows helper for AirBridge (GPL-3.0-or-later).
//
//   airbridge-helper audio     list active audio outputs: "<*| >\t<id>\t<name>" per line
//                              ('*' marks the default device; id is IMMDevice::GetId,
//                              which is what GStreamer's wasapisink "device" expects)
//   airbridge-helper windows <pid>  list that process's visible windows (for screenshots)
//   airbridge-helper input     read input commands from stdin, one per line:
//       m <dx> <dy>            relative mouse move
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
#include <cstdio>
#include <cstring>
#include <string>

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

int main(int argc, char **argv) {
  setvbuf(stdout, nullptr, _IONBF, 0);
  if (argc >= 3 && !strcmp(argv[1], "windows")) return EnumWindows(enumWin, (LPARAM)strtoul(argv[2], nullptr, 10)) ? 0 : 1;
  if (argc >= 2 && !strcmp(argv[1], "audio")) return listAudio();
  if (argc >= 2 && !strcmp(argv[1], "input")) return inputLoop();
  fprintf(stderr, "usage: airbridge-helper audio | input\n");
  return 2;
}
