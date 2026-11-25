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
