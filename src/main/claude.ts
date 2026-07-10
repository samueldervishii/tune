import { spawn, type ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import type { AppEvent } from "../shared/types";

// stdin is ignored, stdout+stderr are piped, hence this exact process shape.
type ClaudeChild = ChildProcessByStdio<null, Readable, Readable>;

// v1 allowlist: read-only tools only. Anything not in this list is auto-denied
// by the CLI in headless mode, so Claude physically cannot Bash/Write/Edit.
const ALLOWED_TOOLS = ["Read", "Glob", "Grep"];

// Name of the CLI binary. Assumed to be on PATH and already authenticated via
// `claude /login`. We never touch ANTHROPIC_API_KEY.
const CLAUDE_BIN = "claude";

type ClaudeEvents = {
  event: [AppEvent];
};

/**
 * Owns the lifecycle of the `claude` CLI subprocess for one chat session.
 *
 * Strategy: spawn a fresh `claude --print` process per user turn, and thread the
 * conversation together with `--resume <session_id>`. This is simpler and more
 * robust than keeping a long-lived stdin stream alive, and the CLI restores full
 * context from the session id each turn.
 */
export class ClaudeSession extends EventEmitter<ClaudeEvents> {
  private child: ClaudeChild | null = null;
  private sessionId: string | null = null;
  private stdoutBuffer = "";
  private cwd: string;

  constructor(cwd: string) {
    super();
    this.cwd = cwd;
  }

  get busy(): boolean {
    return this.child !== null;
  }

  get workingDir(): string {
    return this.cwd;
  }

  /**
   * Point the session at a new directory. This starts a fresh conversation: a
   * resumed session_id is bound to the directory it was created in, so we drop
   * it and let the next `send()` open a new session.
   */
  setWorkingDir(dir: string): void {
    if (dir === this.cwd) return;
    this.cwd = dir;
    this.sessionId = null;
  }

  /** Forget the current session so the next send() opens a fresh conversation. */
  newConversation(): void {
    this.sessionId = null;
  }

  send(prompt: string): void {
    if (this.child) {
      this.emitEvent({ kind: "error", message: "A request is already running." });
      return;
    }

    const args = [
      "--print",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose", // required alongside stream-json in --print mode
      "--allowedTools",
      ALLOWED_TOOLS.join(","),
      "--permission-mode",
      "default",
    ];
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    this.emitEvent({ kind: "status", state: "thinking" });

    let child: ClaudeChild;
    try {
      child = spawn(CLAUDE_BIN, args, {
        cwd: this.cwd,
        // Pass through the existing environment so the CLI finds its own stored
        // credentials. We deliberately never set ANTHROPIC_API_KEY here.
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      this.child = null;
      this.emitEvent({
        kind: "error",
        message: `Failed to launch '${CLAUDE_BIN}': ${(err as Error).message}`,
      });
      this.emitEvent({ kind: "status", state: "idle" });
      return;
    }

    this.child = child;
    this.stdoutBuffer = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      this.child = null;
      this.emitEvent({
        kind: "error",
        message: `Failed to launch '${CLAUDE_BIN}': ${err.message}. Is the CLI installed and on PATH?`,
      });
      this.emitEvent({ kind: "status", state: "idle" });
    });

    child.on("close", (code) => {
      this.flushBuffer();
      this.child = null;
      if (code && code !== 0) {
        this.emitEvent({
          kind: "error",
          message: `claude exited with code ${code}. ${stderr.trim()}`.trim(),
        });
      }
      this.emitEvent({ kind: "status", state: "idle" });
    });
  }

  cancel(): void {
    const child = this.child;
    if (!child) return;
    child.kill("SIGTERM");
    // If it's still alive a couple seconds later, force it down.
    const pid = child.pid;
    setTimeout(() => {
      if (this.child && this.child.pid === pid) {
        this.child.kill("SIGKILL");
      }
    }, 2000);
  }

  // --- stream-json parsing -------------------------------------------------

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) this.handleLine(line);
    }
  }

  private flushBuffer(): void {
    const line = this.stdoutBuffer.trim();
    this.stdoutBuffer = "";
    if (line) this.handleLine(line);
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      // Not JSON (e.g. a stray warning line) — ignore.
      return;
    }
    this.route(msg);
  }

  private route(msg: any): void {
    switch (msg?.type) {
      case "system":
        // Emitted once at start (subtype "init") with the session id.
        if (typeof msg.session_id === "string") this.sessionId = msg.session_id;
        break;

      case "assistant": {
        // A complete assistant message: content is an array of blocks.
        const content: any[] = msg.message?.content ?? [];
        for (const block of content) {
          if (block?.type === "text" && block.text) {
            this.emitEvent({ kind: "assistant-text", text: block.text });
          } else if (block?.type === "tool_use") {
            this.emitEvent({
              kind: "tool-call",
              id: block.id,
              name: block.name,
              input: block.input,
            });
          }
        }
        break;
      }

      case "user": {
        // Tool results come back as a "user" message with tool_result blocks.
        const content: any[] = msg.message?.content ?? [];
        for (const block of content) {
          if (block?.type === "tool_result") {
            this.emitEvent({
              kind: "tool-result",
              id: block.tool_use_id,
              content: stringifyToolResult(block.content),
              isError: Boolean(block.is_error),
            });
          }
        }
        break;
      }

      case "result": {
        if (typeof msg.session_id === "string") this.sessionId = msg.session_id;
        this.emitEvent({
          kind: "result",
          text: typeof msg.result === "string" ? msg.result : "",
          sessionId: msg.session_id ?? this.sessionId,
          costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null,
          durationMs: typeof msg.duration_ms === "number" ? msg.duration_ms : null,
          isError: msg.subtype !== "success",
        });
        break;
      }

      default:
        // Unknown event type — ignore for v1.
        break;
    }
  }

  private emitEvent(event: AppEvent): void {
    this.emit("event", event);
  }
}

/** tool_result content may be a plain string or an array of content blocks. */
function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: any) =>
        typeof block?.text === "string" ? block.text : JSON.stringify(block),
      )
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}
