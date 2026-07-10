import type { AppEvent, ClaudeAPI } from "../shared/types";

// The preload exposed `window.claudeAPI`. Declare it for TypeScript.
declare global {
  interface Window {
    claudeAPI: ClaudeAPI;
  }
}

const chat = document.getElementById("chat") as HTMLDivElement;
const toolLog = document.getElementById("tool-log") as HTMLDivElement;
const input = document.getElementById("input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;
const composer = document.getElementById("composer") as HTMLFormElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;
const pickDirBtn = document.getElementById("pick-dir") as HTMLButtonElement;
const dirLabel = document.getElementById("dir-label") as HTMLSpanElement;
const app = document.getElementById("app") as HTMLDivElement;
const menuBtn = document.getElementById("menu-btn") as HTMLButtonElement;
const menuDropdown = document.getElementById("menu-dropdown") as HTMLDivElement;
const toggleToolsBtn = document.getElementById("toggle-tools") as HTMLButtonElement;
const emptyState = document.getElementById("empty-state") as HTMLDivElement;
const emptyDir = document.getElementById("empty-dir") as HTMLSpanElement;
const winMin = document.getElementById("win-min") as HTMLButtonElement;
const winMax = document.getElementById("win-max") as HTMLButtonElement;
const winClose = document.getElementById("win-close") as HTMLButtonElement;

// The assistant bubble we're currently appending streamed text into, plus the
// raw markdown accumulated so far (re-rendered on each chunk).
let currentAssistantEl: HTMLDivElement | null = null;
let currentAssistantRaw = "";
// Map tool_use id -> its rendered card, so results can be matched back.
const toolCards = new Map<string, HTMLDivElement>();

// --- rendering helpers -----------------------------------------------------

function scrollToBottom(el: HTMLElement): void {
  el.scrollTop = el.scrollHeight;
}

function hideEmptyState(): void {
  emptyState.hidden = true;
}

function addUserMessage(text: string): void {
  hideEmptyState();
  const el = document.createElement("div");
  el.className = "msg user";
  el.textContent = text;
  chat.appendChild(el);
  currentAssistantEl = null; // next assistant text starts a fresh bubble
  scrollToBottom(chat);
}

function appendAssistantText(text: string): void {
  hideEmptyState();
  if (!currentAssistantEl) {
    currentAssistantEl = document.createElement("div");
    currentAssistantEl.className = "msg assistant markdown";
    chat.appendChild(currentAssistantEl);
    currentAssistantRaw = "";
  }
  currentAssistantRaw += text;
  currentAssistantEl.innerHTML = renderMarkdown(currentAssistantRaw);
  scrollToBottom(chat);
}

function addSystemNote(text: string, isError = false): void {
  hideEmptyState();
  const el = document.createElement("div");
  el.className = isError ? "note error" : "note";
  el.textContent = text;
  chat.appendChild(el);
  currentAssistantEl = null;
  scrollToBottom(chat);
}

// Clear the transcript and tool log, and bring back the greeting.
function clearConversation(): void {
  chat.querySelectorAll(".msg, .note").forEach((el) => el.remove());
  toolLog.replaceChildren();
  toolCards.clear();
  currentAssistantEl = null;
  emptyState.hidden = false;
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max = 4000): string {
  return text.length > max ? text.slice(0, max) + `\n… (${text.length - max} more chars)` : text;
}

// --- minimal, safe markdown ------------------------------------------------
// Everything is HTML-escaped FIRST, then a fixed set of tags is introduced by
// us. Because raw input can never produce a tag, this is injection-safe. Links
// are restricted to http(s) and opened externally (see the click handler).

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderInline(text: string): string {
  let s = escapeHtml(text);

  // Protect inline code spans from further formatting.
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(c);
    return `\uE000${codes.length - 1}\uE000`;
  });

  // Bold, then italic (bold first so ** wins over *).
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_]+)_/g, "$1<em>$2</em>");

  // Links [text](http(s)://...) — scheme-restricted, no quotes/spaces in URL.
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)"']+)\)/g,
    (_m, label: string, url: string) => `<a href="${url}" data-external="1">${label}</a>`,
  );

  // Restore inline code (already escaped).
  s = s.replace(/\uE000(\d+)\uE000/g, (_m, n: string) => `<code>${codes[Number(n)]}</code>`);
  return s;
}

function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let html = "";
  let listType: "ul" | "ol" | null = null;
  let inCode = false;
  let codeBuf: string[] = [];

  const flushList = () => {
    if (listType) {
      html += `</${listType}>`;
      listType = null;
    }
  };
  const flushCode = () => {
    html += `<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`;
    codeBuf = [];
  };

  for (const line of lines) {
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      if (inCode) {
        inCode = false;
        flushCode();
      } else {
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushList();
      const level = heading[1].length + 2; // # -> h3, ## -> h4, ### -> h5
      html += `<h${level}>${renderInline(heading[2])}</h${level}>`;
      continue;
    }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      if (listType !== "ul") {
        flushList();
        html += "<ul>";
        listType = "ul";
      }
      html += `<li>${renderInline(ul[1])}</li>`;
      continue;
    }

    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (listType !== "ol") {
        flushList();
        html += "<ol>";
        listType = "ol";
      }
      html += `<li>${renderInline(ol[1])}</li>`;
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushList();
      html += `<blockquote>${renderInline(quote[1])}</blockquote>`;
      continue;
    }

    if (line.trim() === "") {
      flushList();
      continue;
    }

    flushList();
    html += `<p>${renderInline(line)}</p>`;
  }

  flushList();
  if (inCode) flushCode(); // tolerate an unclosed fence mid-stream
  return html;
}

function addToolCall(id: string, name: string, toolInput: unknown): void {
  const card = document.createElement("div");
  card.className = "tool pending";

  const header = document.createElement("div");
  header.className = "tool-name";
  header.textContent = name;

  const inputPre = document.createElement("pre");
  inputPre.className = "tool-input";
  inputPre.textContent = pretty(toolInput);

  const resultPre = document.createElement("pre");
  resultPre.className = "tool-result";
  resultPre.textContent = "…running";

  card.append(header, inputPre, resultPre);
  toolLog.appendChild(card);
  toolCards.set(id, card);
  scrollToBottom(toolLog);
}

function addToolResult(id: string, content: string, isError: boolean): void {
  const card = toolCards.get(id);
  if (!card) return;
  card.classList.remove("pending");
  card.classList.add(isError ? "failed" : "done");
  const resultPre = card.querySelector(".tool-result") as HTMLPreElement;
  resultPre.textContent = truncate(content);
  scrollToBottom(toolLog);
}

function setBusy(busy: boolean): void {
  sendBtn.disabled = busy;
  input.disabled = busy;
  stopBtn.hidden = !busy;
  pickDirBtn.disabled = busy; // can't switch directories mid-run
  statusEl.textContent = busy ? "thinking…" : "ready";
  statusEl.className = busy ? "status busy" : "status idle";
  if (!busy) input.focus();
}

function basename(dirPath: string): string {
  const parts = dirPath.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : dirPath;
}

function showWorkingDir(dirPath: string): void {
  dirLabel.textContent = basename(dirPath);
  pickDirBtn.title = `Working directory: ${dirPath} (click to change)`;
  emptyDir.textContent = basename(dirPath);
  emptyDir.title = dirPath;
}

// --- working directory + conversation --------------------------------------

async function changeDir(): Promise<void> {
  const dir = await window.claudeAPI.pickWorkingDir();
  if (!dir) return; // cancelled, or a request is running
  showWorkingDir(dir);
  addSystemNote(`working directory: ${dir} (new conversation)`);
}

function newConversation(): void {
  window.claudeAPI.newConversation();
  clearConversation();
}

const TOOLS_COLLAPSED_KEY = "tune.toolsCollapsed";

function toggleTools(): void {
  const collapsed = app.classList.toggle("tools-collapsed");
  try {
    localStorage.setItem(TOOLS_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    /* localStorage unavailable — non-fatal */
  }
}

// Tool activity is collapsed by default; restore the user's last choice.
function restoreToolsState(): void {
  let collapsed = true; // default: closed
  try {
    const stored = localStorage.getItem(TOOLS_COLLAPSED_KEY);
    if (stored !== null) collapsed = stored === "1";
  } catch {
    /* ignore */
  }
  app.classList.toggle("tools-collapsed", collapsed);
}

// Grow the input with its content, up to the CSS max-height.
function autoResizeInput(): void {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}

// --- event handling --------------------------------------------------------

function handleEvent(event: AppEvent): void {
  switch (event.kind) {
    case "status":
      setBusy(event.state === "thinking");
      break;
    case "assistant-text":
      appendAssistantText(event.text);
      break;
    case "tool-call":
      addToolCall(event.id, event.name, event.input);
      break;
    case "tool-result":
      addToolResult(event.id, event.content, event.isError);
      break;
    case "result":
      if (event.isError && event.text) {
        addSystemNote(event.text, true);
      }
      if (event.costUsd != null || event.durationMs != null) {
        const cost = event.costUsd != null ? `$${event.costUsd.toFixed(4)}` : "—";
        const dur = event.durationMs != null ? `${(event.durationMs / 1000).toFixed(1)}s` : "—";
        statusEl.title = `last turn: ${cost} · ${dur}`;
      }
      break;
    case "error":
      addSystemNote(event.message, true);
      break;
  }
}

window.claudeAPI.onEvent(handleEvent);

// Links inside rendered markdown open in the user's real browser, never in-app.
chat.addEventListener("click", (e) => {
  const anchor = (e.target as HTMLElement).closest("a[data-external]") as HTMLAnchorElement | null;
  if (!anchor) return;
  e.preventDefault();
  const href = anchor.getAttribute("href");
  if (href) window.claudeAPI.openExternal(href);
});

// --- input -----------------------------------------------------------------

function submit(): void {
  const text = input.value.trim();
  if (!text || sendBtn.disabled) return;
  addUserMessage(text);
  window.claudeAPI.send(text);
  input.value = "";
  autoResizeInput();
}

composer.addEventListener("submit", (e) => {
  e.preventDefault();
  submit();
});

// Enter sends, Shift+Enter inserts a newline.
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});

input.addEventListener("input", autoResizeInput);

// Stop the in-flight request. The main process kills the CLI subprocess, which
// emits a `status: idle` event that re-enables the composer.
stopBtn.addEventListener("click", () => {
  window.claudeAPI.cancel();
  addSystemNote("stopped");
});

// Working-directory picker (header button).
pickDirBtn.addEventListener("click", () => void changeDir());

// Tool-panel toggle (title-bar icon).
toggleToolsBtn.addEventListener("click", toggleTools);

// --- window controls (frameless title bar) ---------------------------------

winMin.addEventListener("click", () => window.claudeAPI.windowControl("minimize"));
winMax.addEventListener("click", () => window.claudeAPI.windowControl("maximize"));
winClose.addEventListener("click", () => window.claudeAPI.windowControl("close"));

// --- hamburger menu --------------------------------------------------------

function closeMenu(): void {
  menuDropdown.hidden = true;
}

menuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  menuDropdown.hidden = !menuDropdown.hidden;
});

// Click anywhere else closes the menu.
document.addEventListener("click", (e) => {
  if (!menuDropdown.hidden && !menuDropdown.contains(e.target as Node)) {
    closeMenu();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});

menuDropdown.addEventListener("click", (e) => {
  const action = (e.target as HTMLElement).closest("[data-action]")?.getAttribute("data-action");
  if (!action) return;
  closeMenu();
  switch (action) {
    case "new":
      newConversation();
      break;
    case "pick-dir":
      void changeDir();
      break;
    case "toggle-tools":
      toggleTools();
      break;
    case "reload":
      window.claudeAPI.windowControl("reload");
      break;
    case "devtools":
      window.claudeAPI.windowControl("toggle-devtools");
      break;
    case "help":
      window.claudeAPI.showHelp();
      break;
    case "about":
      window.claudeAPI.showAbout();
      break;
    case "quit":
      window.claudeAPI.windowControl("quit");
      break;
  }
});

// Load the initial working directory into the header + greeting.
window.claudeAPI.getWorkingDir().then(showWorkingDir);

restoreToolsState();
autoResizeInput();
input.focus();
