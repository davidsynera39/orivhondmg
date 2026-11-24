// Orivon desktop shell: runs the bundled Express server locally and shows it in a window.
const { app, BrowserWindow, dialog, shell, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const net = require("net");
const crypto = require("crypto");

const userData = app.getPath("userData"); // ~/Library/Application Support/Orivon
const ENV_PATH = path.join(userData, ".env");
let win = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

function ensureEnvFile() {
  fs.mkdirSync(userData, { recursive: true });
  if (fs.existsSync(ENV_PATH)) return;
  const template = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8")
    .replace("change-this-to-a-long-random-string", crypto.randomBytes(48).toString("hex"));
  fs.writeFileSync(ENV_PATH, template, { mode: 0o600 });
}

function configIsComplete() {
  require("dotenv").config({ path: ENV_PATH, quiet: true });
  const url = process.env.DATABASE_URL || "";
  return url && !url.includes("[YOUR-");
}

async function start() {
  ensureEnvFile();

  while (!configIsComplete()) {
    const { response } = await dialog.showMessageBox({
      type: "info",
      message: "Orivon needs to be configured",
      detail: `Add your DATABASE_URL (and optionally GROQ_API_KEY, RESEND_API_KEY, PAYSTACK_SECRET_KEY) to:\n\n${ENV_PATH}\n\nThen choose "I've saved it".`,
      buttons: ["Open config file", "I've saved it", "Quit"],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 2) return app.quit();
    if (response === 0) await shell.openPath(ENV_PATH);
    // dotenv won't override already-set vars, so clear the placeholder before re-reading
    delete process.env.DATABASE_URL;
  }

  const port = await freePort();
  process.env.PORT = String(port);
  process.env.APP_URL = `http://localhost:${port}`;
  process.env.STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(userData, "storage");

  try {
    require("../server/index.js"); // starts listening on PORT
  } catch (err) {
    dialog.showErrorBox("Orivon couldn't start", String(err && err.message || err));
    return app.quit();
  }

  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    title: "Orivon",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#ffffff",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Open external links in the default browser, keep app navigation inside.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(`http://localhost:${port}`)) { e.preventDefault(); shell.openExternal(url); }
  });
  await waitForServer(port);
  win.loadURL(`http://localhost:${port}`);
  win.on("closed", () => { win = null; });
}

function waitForServer(port, tries = 50) {
  return new Promise((resolve) => {
    const attempt = (n) => {
      const s = net.connect(port, "127.0.0.1");
      s.on("connect", () => { s.destroy(); resolve(); });
      s.on("error", () => (n > 0 ? setTimeout(() => attempt(n - 1), 100) : resolve()));
    };
    attempt(tries);
  });
}

const menu = Menu.buildFromTemplate([
  { role: "appMenu" },
  { role: "editMenu" },
  { role: "viewMenu" },
  { role: "windowMenu" },
  { label: "Help", submenu: [{ label: "Open config file", click: () => shell.openPath(ENV_PATH) }] },
]);

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => { Menu.setApplicationMenu(menu); start(); });
app.on("window-all-closed", () => app.quit());
app.on("activate", () => { if (!win && app.isReady()) start(); });
