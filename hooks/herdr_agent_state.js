#!/usr/bin/env node
/**
 * Report zcode lifecycle events to herdr.
 *
 * Part of the herdr-zcode plugin. zcode is not a built-in herdr agent, so
 * herdr cannot classify its panes by process/screen. Instead this hook
 * reports pane agent state directly over the herdr CLI (the self-reporting
 * path documented at herdr.dev/docs/add-herdr-support/), so the pane shows up
 * in the sidebar with live idle/working/blocked state and can be reattached
 * to the right zcode session after a herdr restart.
 *
 * Installed under hooks.events.* in ~/.zcode/cli/setting.json by
 * scripts/manage_hooks.js. Stdin payload is Claude-compatible:
 * {"hook_event_name", "session_id", ...}. Runs only inside herdr panes
 * (guarded by the HERDR_* env vars herdr injects); outside herdr it exits
 * immediately.
 *
 * Node is used instead of Python because zcode itself requires Node 22+, so
 * every machine that can run zcode can run this hook (macOS/Linux/Windows).
 */

"use strict";

const { spawnSync } = require("node:child_process");

// Per herdr.dev/docs/add-herdr-support/: stable, unique, and NOT prefixed
// with "herdr:" (reserved for herdr's own built-in integrations).
const SOURCE = "zcode-herdr";
const AGENT = "zcode";

const EVENT_STATES = {
  SessionStart: "idle",
  UserPromptSubmit: "working",
  PreToolUse: "working",
  PostToolUse: "working",
  PostToolUseFailure: "working",
  PermissionRequest: "blocked",
  Stop: "idle",
};

function readHookInput() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = require("node:fs").readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function run(args) {
  try {
    spawnSync(process.env.HERDR_BIN_PATH || "herdr", args, {
      stdio: "ignore",
      timeout: 10000,
    });
  } catch {
    // Never let reporting break the agent.
  }
}

function main() {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) return;
  const hook = readHookInput();
  // Subagent activity does not drive the top-level pane state.
  if (hook.agent_id) return;

  const state = EVENT_STATES[hook.hook_event_name];
  if (!state) return;

  const paneId = process.env.HERDR_PANE_ID;
  const sessionId = typeof hook.session_id === "string" ? hook.session_id : "";
  const seq = process.hrtime.bigint().toString();
  const base = [
    "pane", "report-agent", paneId,
    "--source", SOURCE, "--agent", AGENT, "--seq", seq,
  ];

  if (hook.hook_event_name === "SessionStart" && sessionId) {
    run([
      "pane", "report-agent-session", paneId,
      "--source", SOURCE, "--agent", AGENT, "--seq", seq,
      "--agent-session-id", sessionId,
      "--", "zcode", "--resume", sessionId,
    ]);
  }

  const args = [...base, "--state", state];
  if (sessionId) args.push("--agent-session-id", sessionId);
  run(args);
}

main();
