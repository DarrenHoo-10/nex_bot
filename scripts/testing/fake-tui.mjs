#!/usr/bin/env node
// A stand-in for a terminal coding agent, for Agent mode tests and the
// herdr-core spike. It never talks to any service.
//
// Behaviour:
//   - enters the alternate screen and draws a prompt "fake> "
//   - echoes every typed line as "you said: <line>"
//   - line "wait": prints a permission prompt and waits for "y"/"n"
//   - line "exit": leaves the alternate screen and exits 0
//   - Ctrl+C (byte 0x03): prints "[interrupted]" and returns to the prompt
//   - line "burst <n>": prints n numbered lines quickly (throughput tests)
//   - line "size": prints the current terminal size
//   - env FAKE_TUI_TRANSCRIPT: appends one JSON line per submitted line there
//   - env FAKE_TUI_TITLE: terminal title (default "fake-tui")
import { appendFileSync } from "node:fs";

const ESC = "\x1b";
const transcript = process.env.FAKE_TUI_TRANSCRIPT || "";
const title = process.env.FAKE_TUI_TITLE || "fake-tui";
const out = (text) => process.stdout.write(text);

let line = "";
let awaitingPermission = false;
let finished = false;

function record(role, text) {
  if (!transcript) return;
  try {
    appendFileSync(transcript, `${JSON.stringify({ type: role, text, at: new Date().toISOString() })}\n`);
  } catch {
    // The transcript is optional telemetry for tests.
  }
}

function prompt() {
  out("fake> ");
}

function leave(code) {
  if (finished) return;
  finished = true;
  out(`${ESC}[?1049l`);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(code);
}

function submit(text) {
  record("user", text);
  if (awaitingPermission) {
    awaitingPermission = false;
    const allowed = text.trim().toLowerCase() === "y";
    out(`\r\npermission ${allowed ? "granted" : "denied"}\r\n`);
    record("assistant", `permission ${allowed ? "granted" : "denied"}`);
    prompt();
    return;
  }
  const command = text.trim();
  if (command === "exit") {
    out("\r\nbye\r\n");
    leave(0);
    return;
  }
  if (command === "wait") {
    awaitingPermission = true;
    out("\r\nAllow fake tool to run? [y/n] ");
    return;
  }
  const burst = /^burst (\d+)$/.exec(command);
  if (burst) {
    const count = Math.min(Number(burst[1]), 200000);
    let chunk = "";
    for (let index = 1; index <= count; index += 1) {
      chunk += `\r\nline ${index} ${"x".repeat(60)}`;
      if (chunk.length > 32768) {
        out(chunk);
        chunk = "";
      }
    }
    out(`${chunk}\r\nburst done ${count}\r\n`);
    prompt();
    return;
  }
  if (command === "size") {
    out(`\r\nsize ${process.stdout.columns}x${process.stdout.rows}\r\n`);
    prompt();
    return;
  }
  out(`\r\nyou said: ${text}\r\n`);
  record("assistant", `you said: ${text}`);
  prompt();
}

function onInput(chunk) {
  for (const char of chunk.toString("utf8")) {
    if (char === "\x03") {
      line = "";
      awaitingPermission = false;
      out("\r\n[interrupted]\r\n");
      record("system", "interrupted");
      prompt();
    } else if (char === "\r" || char === "\n") {
      const text = line;
      line = "";
      submit(text);
    } else if (char === "\x7f" || char === "\b") {
      if (line.length > 0) {
        line = line.slice(0, -1);
        out("\b \b");
      }
    } else if (char >= " ") {
      line += char;
      out(char);
    }
  }
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", onInput);
process.stdin.on("end", () => leave(0));
process.on("SIGTERM", () => leave(143));
process.stdout.on("resize", () => {
  out(`\r\n[resized ${process.stdout.columns}x${process.stdout.rows}]\r\n`);
  prompt();
});

out(`${ESC}]0;${title}\x07${ESC}[?1049h${ESC}[2J${ESC}[H`);
out("fake-tui ready\r\n");
prompt();
