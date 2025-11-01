@echo off
setlocal
set "PROJECT_DIR=%~dp0"

set "PATH=C:\Users\mvp81\AppData\Local\Programs\Python\Python313;%PATH%"

if exist "%PROJECT_DIR%venv\Scripts\python.exe" (
set "PYTHON_EXE=%PROJECT_DIR%venv\Scripts\python.exe"
) else if exist "%PROJECT_DIR%venv\Scripts\activate.bat" (
call "%PROJECT_DIR%venv\Scripts\activate.bat" >nul 2>nul
set "PYTHON_EXE=python"
) else if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" (
set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
) else (
set "PYTHON_EXE=python"
)

"%PYTHON_EXE%" -u "%PROJECT_DIR%whisper_host.py"
set "RC=%ERRORLEVEL%"
endlocal & exit /b %RC%