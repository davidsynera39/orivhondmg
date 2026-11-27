#!/usr/bin/env bash
# Orivon — one-command setup and run.
# Usage: ./setup.sh
set -e

echo "Installing dependencies..."
if ! npm install; then
  echo ""
  echo "npm install failed — this is usually the 'better-sqlite3' native module"
  echo "failing to build. Try:"
  echo "  rm -rf node_modules package-lock.json"
  echo "  npm install express cookie-parser bcryptjs jsonwebtoken zod drizzle-orm better-sqlite3 @anthropic-ai/sdk multer mammoth pdf-parse dotenv"
  echo "  npm install -D drizzle-kit"
  echo "then run this script again."
  exit 1
fi

echo "Setting up the database..."
npm run migrate

echo "Starting the server..."
echo "Once it says 'Orivon server running', open http://localhost:3000"
npm start
