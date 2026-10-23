!include "nsDialogs.nsh"
!include "LogicLib.nsh"

Var ArchiveDirectory
Var ArchiveDirectoryInput

!macro customHeader
  Page custom ArchiveDirectoryPage ArchiveDirectoryPageLeave
!macroend

Function ArchiveDirectoryPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${If} $ArchiveDirectory == ""
    StrCpy $ArchiveDirectory "$DOCUMENTS\İzmirde Reklam Sipariş Takip"
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "Sipariş dosyalarının yerel olarak saklanacağı ana klasörü seçin. Her yönetici ve müşteri için alt klasörler otomatik oluşturulur."
  Pop $1
  ${NSD_CreateDirRequest} 0 34u 100% 13u "$ArchiveDirectory"
  Pop $ArchiveDirectoryInput
  nsDialogs::Show
FunctionEnd

Function ArchiveDirectoryPageLeave
  ${NSD_GetText} $ArchiveDirectoryInput $ArchiveDirectory
  ${If} $ArchiveDirectory == ""
    MessageBox MB_ICONEXCLAMATION|MB_OK "Yerel arşiv klasörünü seçin."
    Abort
  ${EndIf}
FunctionEnd

!macro customInstall
  ${If} $ArchiveDirectory != ""
    CreateDirectory "$APPDATA\İzmirde Reklam Sipariş Takip"
    FileOpen $0 "$APPDATA\İzmirde Reklam Sipariş Takip\archive-root.txt" w
    FileWrite $0 "$ArchiveDirectory"
    FileClose $0
  ${EndIf}
!macroend

!macro customUnInstall
  ; Yerel sipariş arşivi ve kullanıcı verileri bilerek silinmez.
!macroend
