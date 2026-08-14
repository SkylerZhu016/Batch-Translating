Option Explicit

Dim fileSystem, shell, scriptDirectory, powerShellScript, command
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
powerShellScript = fileSystem.BuildPath(scriptDirectory, "Start-BatchTranslating.ps1")

If Not fileSystem.FileExists(powerShellScript) Then
    MsgBox "Start-BatchTranslating.ps1 was not found beside this launcher.", 16, "Batch Translating"
    WScript.Quit 1
End If

command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & QuoteArgument(powerShellScript)
shell.Run command, 0, False

Function QuoteArgument(value)
    QuoteArgument = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
