' Запуск бота без окна консоли. Используется планировщиком заданий и ярлыком автозапуска.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = base
cmd = """C:\Program Files\nodejs\node.exe"" """ & base & "\index.js"""
shell.Run cmd, 0, False
