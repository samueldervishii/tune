import { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeImage } from "electron";
import * as path from "node:path";
import { ClaudeSession } from "./claude";

// GitHub page opened by the Help menu item — the issues tracker, so users land
// where they can report problems or ask for help.
const GITHUB_URL = "https://github.com/samueldervishii/tune/issues";

let win: BrowserWindow | null = null;
let session: ClaudeSession | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: "#0a1730",
    title: "Tune",
    icon: path.join(__dirname, "../renderer/logo-rounded.png"),
    frame: false, // custom frosted title bar drawn in the renderer
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      // --- security: the three settings that matter most ---
      contextIsolation: true, // renderer and preload run in separate JS worlds
      nodeIntegration: false, // no `require`/Node globals in the web page
      sandbox: true, // renderer runs in a locked-down OS sandbox
    },
  });

  win.loadFile(path.join(__dirname, "../renderer/index.html"));

  // Surface renderer lifecycle + console output in the main process log. Handy
  // for development (CSP violations and page errors show up here).
  win.webContents.on("did-finish-load", () => console.log("[renderer] loaded"));
  win.webContents.on("console-message", (_e, _level, message) =>
    console.log("[renderer]", message),
  );
  win.webContents.on("render-process-gone", (_e, details) =>
    console.error("[renderer] gone:", details.reason),
  );

  session = new ClaudeSession(app.getPath("home"));
  session.on("event", (event) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send("claude:event", event);
    }
  });

  win.on("closed", () => {
    session?.cancel();
    session = null;
    win = null;
  });
}

// Renderer -> main. The renderer can only reach these two channels, and only
// through the narrow API defined in the preload.
ipcMain.on("claude:send", (_event, prompt: unknown) => {
  if (typeof prompt === "string" && prompt.trim()) {
    session?.send(prompt);
  }
});

ipcMain.on("claude:cancel", () => {
  session?.cancel();
});

// Start a fresh conversation (drops the resumed session_id).
ipcMain.on("claude:new-session", () => {
  session?.newConversation();
});

// Open http(s) links from rendered markdown in the user's real browser, never
// inside the app window. The scheme is validated before handing it to the OS.
ipcMain.on("open-external", (_event, url: unknown) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
});

// Native About dialog, in the style of a standard desktop app.
ipcMain.on("app:about", () => {
  if (!win) return;
  void dialog.showMessageBox(win, {
    type: "info",
    title: "About Tune",
    message: "Tune",
    detail:
      `A sleek desktop companion for Claude Code.\n\n` +
      `Version ${app.getVersion()}\n` +
      `Electron ${process.versions.electron} · Node ${process.versions.node} · Chromium ${process.versions.chrome}`,
    icon: nativeImage.createFromPath(path.join(__dirname, "../renderer/logo-rounded.png")),
    buttons: ["OK"],
    noLink: true,
  });
});

// Help — opens the GitHub page once GITHUB_URL is set, otherwise says so.
ipcMain.on("app:help", () => {
  if (!win) return;
  if (GITHUB_URL) {
    shell.openExternal(GITHUB_URL);
  } else {
    void dialog.showMessageBox(win, {
      type: "info",
      title: "Help",
      message: "Project page coming soon",
      detail:
        "The Tune GitHub page isn't published yet. Help will open it here once it's available.",
      buttons: ["OK"],
    });
  }
});

// Window controls for the frameless title bar. Only this fixed set of actions
// is honored — the renderer can't ask the main process to do anything else.
ipcMain.on("window:control", (_event, action: unknown) => {
  if (!win) return;
  switch (action) {
    case "minimize":
      win.minimize();
      break;
    case "maximize":
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      break;
    case "close":
      win.close();
      break;
    case "reload":
      win.webContents.reload();
      break;
    case "toggle-devtools":
      win.webContents.toggleDevTools();
      break;
    case "quit":
      app.quit();
      break;
  }
});

ipcMain.handle("claude:get-cwd", () => session?.workingDir ?? app.getPath("home"));

ipcMain.handle("claude:pick-cwd", async () => {
  if (!win || !session) return null;
  // Don't switch directories mid-run — it would reset the session underneath a
  // request that's still streaming.
  if (session.busy) return session.workingDir;

  const result = await dialog.showOpenDialog(win, {
    title: "Choose working directory",
    defaultPath: session.workingDir,
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const dir = result.filePaths[0];
  session.setWorkingDir(dir);
  return dir;
});

app.whenReady().then(() => {
  // Remove the native File/Edit/View/Window/Help menu — the hamburger menu in
  // the custom title bar replaces it.
  Menu.setApplicationMenu(null);
  createWindow();
});

app.on("window-all-closed", () => {
  session?.cancel();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
