// Shared contract between the main process, the preload bridge, and the renderer.
//
// The main process parses Claude Code's raw stream-json and re-emits these
// normalized events. The renderer only ever sees `AppEvent` — never the raw CLI
// JSON. Keep this file free of any runtime code / Node or DOM imports so all three
// contexts can `import type` from it safely.

export type AssistantTextEvent = {
  kind: "assistant-text";
  text: string;
};

export type ToolCallEvent = {
  kind: "tool-call";
  id: string;
  name: string;
  input: unknown;
};

export type ToolResultEvent = {
  kind: "tool-result";
  id: string;
  content: string;
  isError: boolean;
};

export type ResultEvent = {
  kind: "result";
  text: string;
  sessionId: string | null;
  costUsd: number | null;
  durationMs: number | null;
  isError: boolean;
};

export type StatusEvent = {
  kind: "status";
  state: "thinking" | "idle";
};

export type ErrorEvent = {
  kind: "error";
  message: string;
};

export type AppEvent =
  | AssistantTextEvent
  | ToolCallEvent
  | ToolResultEvent
  | ResultEvent
  | StatusEvent
  | ErrorEvent;

// Fixed set of window/app actions the renderer may request from main.
export type WindowAction =
  | "minimize"
  | "maximize"
  | "close"
  | "reload"
  | "toggle-devtools"
  | "quit";

// The surface exposed to the renderer via contextBridge. This is the ONLY thing
// the web page can call — no Node, no ipcRenderer, no filesystem.
export interface ClaudeAPI {
  send(prompt: string): void;
  cancel(): void;
  onEvent(cb: (event: AppEvent) => void): () => void;
  /** Current working directory Claude runs in. */
  getWorkingDir(): Promise<string>;
  /** Open a native folder picker. Returns the chosen path, or null if cancelled. */
  pickWorkingDir(): Promise<string | null>;
  /** Forget the current session so the next message starts a fresh conversation. */
  newConversation(): void;
  /** Frameless title-bar window controls and app actions. */
  windowControl(action: WindowAction): void;
  /** Open an http(s) URL in the user's default browser. */
  openExternal(url: string): void;
  /** Show the native About dialog. */
  showAbout(): void;
  /** Open the project's Help / GitHub page (or a placeholder until it's ready). */
  showHelp(): void;
}
