import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";
import type { AppEvent, ClaudeAPI, WindowAction } from "../shared/types";

// The preload runs in an isolated world with access to a *limited* set of Node
// APIs (ipcRenderer, contextBridge). It is the only bridge between the untrusted
// web page and the privileged main process. We expose a deliberately tiny API —
// no generic "invoke any channel" escape hatch.
const api: ClaudeAPI = {
  send: (prompt: string) => ipcRenderer.send("claude:send", prompt),

  cancel: () => ipcRenderer.send("claude:cancel"),

  onEvent: (cb: (event: AppEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, data: AppEvent) => cb(data);
    ipcRenderer.on("claude:event", listener);
    // Return an unsubscribe handle.
    return () => ipcRenderer.removeListener("claude:event", listener);
  },

  getWorkingDir: () => ipcRenderer.invoke("claude:get-cwd"),

  pickWorkingDir: () => ipcRenderer.invoke("claude:pick-cwd"),

  newConversation: () => ipcRenderer.send("claude:new-session"),

  windowControl: (action: WindowAction) => ipcRenderer.send("window:control", action),

  openExternal: (url: string) => ipcRenderer.send("open-external", url),

  showAbout: () => ipcRenderer.send("app:about"),

  showHelp: () => ipcRenderer.send("app:help"),
};

contextBridge.exposeInMainWorld("claudeAPI", api);
