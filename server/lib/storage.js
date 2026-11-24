const { writeFile, mkdir, unlink } = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(__dirname, "..", "..", "storage");
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

class FileTooLargeError extends Error {}

async function saveUserFile({ userId, category, fileName, buffer }) {
  if (buffer.byteLength > MAX_FILE_SIZE_BYTES) throw new FileTooLargeError("File exceeds the 10MB limit.");

  const dir = path.join(STORAGE_ROOT, category, userId);
  await mkdir(dir, { recursive: true });

  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
  const uniqueName = `${crypto.randomUUID()}-${safeName}`;
  const fullPath = path.join(dir, uniqueName);
  await writeFile(fullPath, buffer);

  return { storagePath: path.relative(STORAGE_ROOT, fullPath) };
}

async function deleteUserDir(category, userId) {
  const dir = path.join(STORAGE_ROOT, category, userId);
  await require("fs/promises").rm(dir, { recursive: true, force: true });
}

module.exports = { saveUserFile, deleteUserDir, FileTooLargeError, STORAGE_ROOT };
