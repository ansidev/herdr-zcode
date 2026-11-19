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
 * Installed under hooks.events.* in ~/.zcode/cli/config.json by
 * scripts/manage_hooks.js. Stdin payload is Claude-compatible:
 * {"hook_event_name", "session_id", ...}. Runs only inside herdr panes
 * (guarded by the HERDR_* env vars herdr injects); outside herdr it exits
 * immediately.
 *
 * Node is used instead of Python because zcode itself requires Node 22+, so
 * every machine that can run zcode can run this hook (macOS/Linux/Windows).
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
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

// Herdr requires --seq to increase with every report from this source,
// including across restarts of zcode. hrtime/bigint resets each run, so
// keep a persistent counter next to the reporter script and always send at
// least the current wall-clock time (ms) so a lost counter file can never
// regress behind previously sent values.
function nextSeq() {
  const seqFile = path.join(__dirname, "herdr_agent_state.seq");
  const now = Date.now();
  let seq = now;
  try {
    const prev = parseInt(fs.readFileSync(seqFile, "utf8"), 10);
    if (Number.isFinite(prev) && prev + 1 > seq) seq = prev + 1;
  } catch {
    // First run or unreadable counter: wall-clock seq still works.
  }
  try {
    fs.writeFileSync(seqFile, String(seq));
  } catch {
    // Unwritable dir: wall-clock seq is still monotonic per ms.
  }
  return String(seq);
}

const TURN_FILE = path.join(__dirname, "herdr_agent_state.turn");

function dbPath() {
  const override = (process.env.ZCODE_SESSION_DB_PATH || "").trim();
  return override ? path.resolve(override) : path.join(process.env.HOME || "", ".zcode", "cli", "db", "db.sqlite");
}

function hasLiveChildren(sessionId, turnStart) {
  if (!sessionId) return false;
  let db;
  try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(dbPath(), { readOnly: true });
    db.exec("PRAGMA busy_timeout=200");
    const row = db
      .prepare(
        "SELECT 1 AS ok FROM session WHERE parent_id = ? AND task_type = 'subagent_child' AND last_outcome IS NULL AND time_updated >= ? LIMIT 1"
      )
      .get(sessionId, turnStart || 0);
    return !!row;
  } catch {
    return false;
  } finally {
    try { if (db) db.close(); } catch { /* ignore */ }
  }
}

function main() {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) return;
  const hook = readHookInput();

  const state = EVENT_STATES[hook.hook_event_name];
  if (!state) return;

  const paneId = process.env.HERDR_PANE_ID;
  const sessionId = typeof hook.session_id === "string" ? hook.session_id : "";
  const base = [
    "pane", "report-agent", paneId,
    "--source", SOURCE, "--agent", AGENT, "--seq", nextSeq(),
  ];

  // Track turn start for stale-child filtering.
  if (hook.hook_event_name === "UserPromptSubmit") {
    try { fs.writeFileSync(TURN_FILE, String(Date.now())); } catch { /* ignore */ }
  }

  let reportState = state;
  if (hook.hook_event_name === "Stop") {
    let turnStart = 0;
    try { turnStart = parseInt(fs.readFileSync(TURN_FILE, "utf8"), 10) || 0; } catch { /* ignore */ }
    if (hasLiveChildren(sessionId, turnStart)) reportState = "working";
  }

  // Session report and state report each get their own increasing seq:
  // herdr drops any report whose seq is not higher than the previous one.
  if (hook.hook_event_name === "SessionStart" && sessionId) {
    run([
      "pane", "report-agent-session", paneId,
      "--source", SOURCE, "--agent", AGENT, "--seq", nextSeq(),
      "--agent-session-id", sessionId,
      "--", "zcode", "--resume", sessionId,
    ]);
  }

  const args = [...base, "--state", reportState];
  // Explain the block so herdr's UI can show why the agent is waiting.
  if (hook.hook_event_name === "PermissionRequest" &&
      typeof hook.tool_name === "string" && hook.tool_name) {
    args.push("--message", `zcode needs approval to run ${hook.tool_name}`);
  }
  if (sessionId) args.push("--agent-session-id", sessionId);
  run(args);
}

main();
