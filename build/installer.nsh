; ---------------------------------------------------------------------------
; Dynamic Island - installer customisation
;
; The only thing we change is the Start Menu entry: it is the one Windows
; Search indexes. Per the product decision, searching "dynamic" should land
; you in Settings, so the shortcut launches the app with --settings (which
; starts the island in the background and opens the settings window).
; ---------------------------------------------------------------------------

!macro customInstall
  CreateShortCut "$SMPROGRAMS\Dynamic Island Settings.lnk" \
    "$INSTDIR\${APP_EXECUTABLE_FILENAME}" \
    "--settings" \
    "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 SW_SHOWNORMAL "" \
    "Dynamic Island settings"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\Dynamic Island Settings.lnk"
  ; the app also writes a per-user autostart shortcut on first run
  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Dynamic Island.lnk"
!macroend
