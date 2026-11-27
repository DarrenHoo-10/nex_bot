!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!ifndef BUILD_UNINSTALLER
  Var NexBotInitialDir
  Var NexBotRegisteredDir
!endif

!macro customInit
  # Keep the assisted installer in the same per-user scope as the one-click installer.
  ${If} ${isForAllUsers}
    SetErrorLevel 2
    Abort
  ${EndIf}
  StrCpy $hasPerMachineInstallation "0"
  StrCpy $hasPerUserInstallation "1"
  !insertmacro setInstallModePerUser
  ReadRegStr $NexBotRegisteredDir HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $NexBotRegisteredDir != ""
    StrCpy $INSTDIR $NexBotRegisteredDir
  ${Else}
    !insertmacro GetDParameter $0
    ${If} $0 == ""
      ${GetParent} "$INSTDIR" $0
      StrCpy $INSTDIR "$0\NexBot"
    ${EndIf}
  ${EndIf}
  GetFullPathName $INSTDIR "$INSTDIR"
  StrCpy $NexBotInitialDir $INSTDIR
  ${If} ${Silent}
    Call NexBotValidateDirectory
    ${If} ${Errors}
      SetErrorLevel 2
      Abort
    ${EndIf}
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_PRE NexBotDirectoryPre
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW NexBotDirectoryShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE NexBotDirectoryLeave
  !insertmacro MUI_PAGE_DIRECTORY

  Function NexBotDirectoryPre
    StrCpy $INSTDIR $NexBotInitialDir
  FunctionEnd

  Function NexBotDirectoryShow
    ${If} $NexBotRegisteredDir != ""
      EnableWindow $mui.DirectoryPage.Directory 0
      EnableWindow $mui.DirectoryPage.BrowseButton 0
      ${If} $LANGUAGE == 2052
        StrCpy $0 "检测到 NexBot 已安装。继续将更新原安装目录。"
      ${Else}
        StrCpy $0 "NexBot is already installed. Continue to update it in the same folder."
      ${EndIf}
      ${NSD_SetText} $mui.DirectoryPage.Text "$0"
    ${EndIf}
  FunctionEnd

  Function NexBotDirectoryLeave
    ${NSD_GetText} $mui.DirectoryPage.Directory $0
    GetFullPathName $INSTDIR "$0"
    Call NexBotValidateDirectory
    ${If} ${Errors}
      ${If} $NexBotRegisteredDir != ""
        ${If} $LANGUAGE == 2052
          StrCpy $0 "旧安装目录不可用。请先在 Windows 的“已安装的应用”中移除旧安装，再重试。"
        ${Else}
          StrCpy $0 "The existing installation folder cannot be used. Remove NexBot in Windows Installed apps and try again."
        ${EndIf}
      ${ElseIf} $LANGUAGE == 2052
        StrCpy $0 "请选择一个新建或空的文件夹作为 NexBot 安装目录。"
      ${Else}
        StrCpy $0 "Choose a new or empty folder for NexBot."
      ${EndIf}
      MessageBox MB_OK|MB_ICONEXCLAMATION "$0"
      Abort
    ${EndIf}
  FunctionEnd

  Function NexBotValidateDirectory
    ${GetRoot} "$INSTDIR" $0
    GetFullPathName $1 "$APPDATA\NexBotClient"
    StrCpy $2 "$INSTDIR\"
    StrLen $3 "$1\"
    StrCpy $2 $2 $3
    ClearErrors
    ${If} $0 == ""
    ${OrIf} $INSTDIR == $0
    ${OrIf} $INSTDIR == "$0\"
    ${OrIf} $2 == "$1\"
      SetErrors
      Return
    ${EndIf}

    # NSIS owns the entire installation directory and removes it on uninstall.
    ${DirState} "$INSTDIR" $0
    ClearErrors
    ${If} $0 == 1
      GetFullPathName $1 "$NexBotRegisteredDir"
      ${If} $NexBotRegisteredDir == ""
      ${OrIf} $INSTDIR != $1
      ${OrIfNot} ${FileExists} "$INSTDIR\${UNINSTALL_FILENAME}"
        SetErrors
      ${EndIf}
    ${ElseIf} $0 == -1
    ${AndIf} ${FileExists} "$INSTDIR"
      SetErrors
    ${EndIf}
  FunctionEnd
!macroend

!macro NEXBOT_FIND_IN_INSTDIR _OUT
  System::Call 'kernel32::SetEnvironmentVariable(t "NEXBOT_INSTDIR", t "$INSTDIR")'
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d=[IO.Path]::GetFullPath($$env:NEXBOT_INSTDIR).TrimEnd('\')+'\'; if(@(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.Name -ne '${UNINSTALL_FILENAME}' -and $$_.ExecutablePath.StartsWith($$d,[StringComparison]::OrdinalIgnoreCase) }).Count -gt 0){ exit 0 } else { exit 1 }"`
  Pop ${_OUT}
  ${If} ${_OUT} != 0
  ${AndIf} ${_OUT} != 1
    nsExec::Exec `"$CmdPath" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop ${_OUT}
  ${EndIf}
!macroend

!macro NEXBOT_KILL_IN_INSTDIR
  System::Call 'kernel32::SetEnvironmentVariable(t "NEXBOT_INSTDIR", t "$INSTDIR")'
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d=[IO.Path]::GetFullPath($$env:NEXBOT_INSTDIR).TrimEnd('\')+'\'; Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.Name -ne '${UNINSTALL_FILENAME}' -and $$_.ExecutablePath.StartsWith($$d,[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $R9
  ${If} $R9 != 0
    nsExec::Exec `"$CmdPath" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
    Pop $R9
  ${EndIf}
!macroend

!macro customCheckAppRunning
  Push $R0
  Push $R1
  Push $R2
  Push $R9

  !insertmacro NEXBOT_FIND_IN_INSTDIR $R0
  ${If} $R0 == 0
    ${If} ${isUpdated}
      Sleep 300
    ${ElseIfNot} ${Silent}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK +2
      Quit
    ${EndIf}

    DetailPrint "$(appClosing)"

    # Ask the running client to quit cleanly first so the tray icon and device session shut down gracefully.
    ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit'
    ${EndIf}

    StrCpy $R1 0
    ${Do}
      Sleep 500
      !insertmacro NEXBOT_FIND_IN_INSTDIR $R0
      ${If} $R0 != 0
        ${ExitDo}
      ${EndIf}
      IntOp $R1 $R1 + 1
    ${LoopUntil} $R1 >= 6

    ${If} $R0 == 0
      StrCpy $R1 0
      ${Do}
        IntOp $R1 $R1 + 1
        !insertmacro NEXBOT_KILL_IN_INSTDIR
        StrCpy $R2 0
        ${Do}
          Sleep 500
          !insertmacro NEXBOT_FIND_IN_INSTDIR $R0
          ${If} $R0 != 0
            ${ExitDo}
          ${EndIf}
          IntOp $R2 $R2 + 1
        ${LoopUntil} $R2 >= 5

        ${If} $R0 != 0
          ${ExitDo}
        ${EndIf}

        ${If} $R1 >= 2
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY +2
          Quit
          StrCpy $R1 0
        ${EndIf}
      ${Loop}
    ${EndIf}
  ${EndIf}

  Pop $R9
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!ifdef BUILD_UNINSTALLER
  !macro customRemoveFiles
    # Release our own working-directory handle on $INSTDIR before moving or removing files.
    SetOutPath $TEMP
    ${If} ${isUpdated}
      ${StdUtils.GetParentPath} $R6 "$INSTDIR"
      StrCpy $R7 ""
      ${If} $R6 != ""
      ${AndIf} $R6 != "$INSTDIR"
        StrCpy $R7 "$R6\.nexbot-old-install"
        RMDir /r "$R7"
        ClearErrors
        CreateDirectory "$R7"
        ${If} ${Errors}
          StrCpy $R7 ""
        ${EndIf}
      ${EndIf}

      ${If} $R7 != ""
        # Same-volume rename of top-level entries is instant on NTFS and avoids copying hundreds of MB to C:\Temp.
        StrCpy $R3 ""
        FindFirst $R1 $R2 "$INSTDIR\*.*"
        ${DoWhile} $R2 != ""
          ${If} $R2 != "."
          ${AndIf} $R2 != ".."
            ClearErrors
            Rename "$INSTDIR\$R2" "$R7\$R2"
            ${If} $R2 == "${UNINSTALL_FILENAME}"
              ClearErrors
            ${EndIf}
            ${If} ${Errors}
              StrCpy $R3 "$INSTDIR\$R2"
              ${ExitDo}
            ${EndIf}
          ${EndIf}
          FindNext $R1 $R2
        ${Loop}
        FindClose $R1

        ${If} $R3 != ""
          DetailPrint "File is busy, aborting: $R3"
          FindFirst $R1 $R2 "$R7\*.*"
          ${DoWhile} $R2 != ""
            ${If} $R2 != "."
            ${AndIf} $R2 != ".."
              Rename "$R7\$R2" "$INSTDIR\$R2"
            ${EndIf}
            FindNext $R1 $R2
          ${Loop}
          FindClose $R1
          RMDir "$R7"
          Abort `Can't rename "$R3" to "$R7".`
        ${EndIf}

        RMDir /r "$R7"
      ${Else}
        # Fallback when the parent directory is not writable: use electron-builder's cross-drive file move.
        CreateDirectory "$PLUGINSDIR\old-install"
        Push ""
        Call un.atomicRMDir
        Pop $R0
        ${If} $R0 != 0
          DetailPrint "File is busy, aborting: $R0"
          Push ""
          Call un.restoreFiles
          Pop $R0
          Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
        ${EndIf}
      ${EndIf}
    ${EndIf}

    RMDir /r $INSTDIR
  !macroend
!endif
