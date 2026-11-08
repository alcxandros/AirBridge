; Extra NSIS steps for electron-builder: Windows Firewall rules so iPhones on
; the local (Private) network can find and connect to the receiver, and so
; phones can reach the file-drop page. Removed again on uninstall.

!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="AirBridge AirPlay receiver"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="AirBridge file drop"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="AirBridge AirPlay receiver" dir=in action=allow enable=yes profile=private program="$INSTDIR\resources\uxplay\bin\uxplay.exe"'
  ; Any protocol: TCP for the phone page, UDP for screen sharing (WebRTC).
  nsExec::Exec 'netsh advfirewall firewall add rule name="AirBridge file drop" dir=in action=allow enable=yes profile=private program="$INSTDIR\AirBridge.exe"'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="AirBridge AirPlay receiver"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="AirBridge file drop"'
!macroend
