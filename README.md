# Tune

A frosted-glass Electron desktop app that wraps the Claude Code CLI in a streaming chat interface.

**Version 0.1.0**

## Prerequisites

- Node.js 18+ and npm
- The Claude Code CLI installed and logged in (`claude /login`). Tune talks to the local CLI and never handles your API key.

## Install

```bash
npm install
```

## Run

```bash
npm start
```

This builds the app and launches the window.

## Notes

- Tools are limited to read-only: `Read`, `Glob`, `Grep`.
- Pick the working directory from the header; the tool activity panel and menu live in the title bar.
