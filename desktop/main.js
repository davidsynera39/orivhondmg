// Orivon desktop: a native window onto the hosted app. No server or keys live in this app.
const { app, BrowserWindow, WebContentsView, shell, Menu } = require("electron");
const path = require("path");

const APP_URL = "https://orivonmentor.onrender.com";
const APP_HOST = new URL(APP_URL).host;
const START_URL = APP_URL + "/#/login"; // login, or straight to the dashboard if already signed in
const MIN_SPLASH_MS = 3000;
const ALLOWED = (host) => host === APP_HOST || host === "paystack.com" || host.endsWith(".paystack.com");

let win = null;

function isAllowed(url) {
  try { return ALLOWED(new URL(url).host); } catch { return false; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    title: "Orivon", backgroundColor: "#F7F5F0",
    titleBarStyle: "hiddenInset",
  });

  const prefs = { contextIsolation: true, nodeIntegration: false, sandbox: true };
  const appView = new WebContentsView({ webPreferences: prefs });
  const splash = new WebContentsView({ webPreferences: prefs });
  win.contentView.addChildView(appView);
  win.contentView.addChildView(splash); // splash sits on top until the app is ready

  const fit = () => {
    const { width, height } = win.getContentBounds();
    appView.setBounds({ x: 0, y: 0, width, height });
    splash.setBounds({ x: 0, y: 0, width, height });
  };
  fit();
  win.on("resize", fit);

  const wc = appView.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (isAllowed(url)) { wc.loadURL(url); } else { shell.openExternal(url); }
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => {
    if (!isAllowed(url)) { e.preventDefault(); shell.openExternal(url); }
  });

  const splashFile = path.join(__dirname, "splash.html");
  splash.webContents.loadFile(splashFile);

  const started = Date.now();
  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    const wait = Math.max(0, MIN_SPLASH_MS - (Date.now() - started));
    setTimeout(() => { if (win) win.contentView.removeChildView(splash); }, wait);
  };

  const load = () => { wc.loadURL(START_URL); };
  wc.on("did-finish-load", reveal);
  wc.on("did-fail-load", (_e, code, _desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = aborted by a redirect
    revealed = false;
    if (!win.contentView.children.includes(splash)) win.contentView.addChildView(splash);
    splash.webContents.executeJavaScript("window.showOffline && window.showOffline()").catch(() => {});
    setTimeout(load, 5000); // keep retrying (also covers the free host waking up)
  });

  // After 3s of splash, if the host is still waking up, tell the user.
  setTimeout(() => {
    if (!revealed) splash.webContents.executeJavaScript("window.showWaking && window.showWaking()").catch(() => {});
  }, MIN_SPLASH_MS);

  load();
  win.on("closed", () => { win = null; });
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
  ]));
  createWindow();
});
app.on("window-all-closed", () => app.quit());
app.on("activate", () => { if (!win && app.isReady()) createWindow(); });
