@echo off
REM Orivon — one-command setup and run.
REM Usage: setup.bat

echo Installing dependencies...
call npm install
if errorlevel 1 (
  echo.
  echo npm install failed - this is usually the "better-sqlite3" native module
  echo failing to build. Try:
  echo   rmdir /s /q node_modules
  echo   del package-lock.json
  echo   npm install express cookie-parser bcryptjs jsonwebtoken zod drizzle-orm better-sqlite3 @anthropic-ai/sdk multer mammoth pdf-parse dotenv
  echo   npm install -D drizzle-kit
  echo then run this script again.
  exit /b 1
)

echo Setting up the database...
call npm run migrate
if errorlevel 1 exit /b 1

echo Starting the server...
echo Once it says "Orivon server running", open http://localhost:3000
call npm start
