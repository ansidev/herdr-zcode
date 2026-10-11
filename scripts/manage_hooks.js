#!/usr/bin/env node
/**
 * Install / remove / report status of the zcode -> herdr integration hooks.
 *
 * Invoked by the herdr-zcode plugin (actions and the startup hook). It keeps
 * a stable copy of the reporter script in the plugin's herdr-managed config
 * dir and registers it under hooks.events.* in zcode's CLI settings file,
 * replacing any earlier copies of the same integration (matched by script
 * name, including the historical Python variant) so upgrades clean up after
 * themselves.
 *
 * Plain Node with no dependencies: zcode itself requires Node 22+, so this
 * runs anywhere zcode runs (macOS/Linux/Windows).
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPORTER_BASE = "herdr_agent_state";
const REPORTER_JS = `${REPORTER_BASE}.js`;
// Older copies of this integration that must be replaced/removed.
const LEGACY_FILES = [`${REPORTER_BASE}.py`];
const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
];

function envDir(name) {
  const d = (process.env[name] || "").trim();
  if (!d) {
    console.error(
      `${name} is not set; run this via ` +
        "`herdr plugin action invoke herdr-zcode.<action>` instead."
    );
    process.exit(1);
  }
  return d;
}

function settingsPath() {
  const override = (process.env.ZCODE_CLI_SETTINGS_FILE || "").trim();
  return override
    ? path.resolve(override)
    : path.join(os.homedir(), ".zcode", "cli", "setting.json");
}

function loadSettings(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    fail(`${p} could not be parsed (${e.message}); fix it before installing hooks.`);
  }
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function saveSettings(p, settings) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(settings, null, 2) + "\n");
}

// A hook group is "ours" if its command or args reference the reporter.
function isOurs(group) {
  if (!group || !Array.isArray(group.hooks)) return false;
  return group.hooks.some((h) => {
    const hay = [h && h.command, ...(Array.isArray(h && h.args) ? h.args : [])]
      .filter((s) => typeof s === "string")
      .join(" ");
    return hay.includes(REPORTER_BASE);
  });
}

function entryGroup(command, args) {
  // "process" = argv-array execution (no shell); "command" is a shell string
  // and ignores `args`, which is why the process type is required here.
  return { hooks: [{ type: "process", command, args }] };
}

function install() {
  const root = envDir("HERDR_PLUGIN_ROOT");
  const configDir = envDir("HERDR_PLUGIN_CONFIG_DIR");
  const target = path.join(configDir, REPORTER_JS);
  fs.mkdirSync(configDir, { recursive: true });
  fs.copyFileSync(path.join(root, "hooks", REPORTER_JS), target);
  for (const legacy of LEGACY_FILES) {
    fs.rmSync(path.join(configDir, legacy), { force: true });
  }

  const p = settingsPath();
  const settings = loadSettings(p);
  const hooks =
    typeof settings.hooks === "object" && settings.hooks !== null
      ? settings.hooks
      : (settings.hooks = {});
  const events =
    typeof hooks.events === "object" && hooks.events !== null
      ? hooks.events
      : (hooks.events = {});

  const command = process.execPath; // absolute node binary; portable on Windows
  const args = [target];
  let replacedOld = false;

  for (const event of EVENTS) {
    if (!Array.isArray(events[event])) events[event] = [];
    let already = false;
    events[event] = events[event].filter((group) => {
      if (!isOurs(group)) return true;
      replacedOld = true;
      if (!already && JSON.stringify(group) === JSON.stringify(entryGroup(command, args))) {
        already = true;
        return true;
      }
      return false;
    });
    if (!already) events[event].push(entryGroup(command, args));
  }

  let enabledNote = "";
  if (hooks.enabled !== true) {
    hooks.enabled = true;
    enabledNote = " (hooks.enabled was off; set to true)";
  }

  saveSettings(p, settings);
  console.log(`installed: reporter at ${target}`);
  console.log(`registered on ${EVENTS.length} events in ${p}${enabledNote}`);
  if (replacedOld) console.log("replaced older herdr_agent_state entries");
}

function remove() {
  const p = settingsPath();
  const settings = loadSettings(p);
  const hooks = settings.hooks;
  if (!hooks || typeof hooks.events !== "object" || hooks.events === null) {
    console.log("no integration entries found; nothing to do");
    return;
  }
  let removed = 0;
  for (const [event, groups] of Object.entries(hooks.events)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((g) => !isOurs(g));
    removed += groups.length - kept.length;
    hooks.events[event] = kept;
  }
  saveSettings(p, settings);
  const configDir = (process.env.HERDR_PLUGIN_CONFIG_DIR || "").trim();
  if (configDir) {
    for (const f of [REPORTER_JS, ...LEGACY_FILES]) {
      try {
        fs.rmSync(path.join(configDir, f), { force: true });
        removed += 1;
      } catch {
        // best effort
      }
    }
  }
  console.log(`removed ${removed} item(s); zcode hooks block left in place`);
}

function status() {
  const p = settingsPath();
  const settings = loadSettings(p);
  const hooks = settings.hooks || {};
  const events = hooks.events || {};
  const found = Object.keys(events).filter((event) =>
    Array.isArray(events[event]) && events[event].some(isOurs)
  );
  const configDir = (process.env.HERDR_PLUGIN_CONFIG_DIR || "").trim();
  const reporterOk = configDir
    ? fs.existsSync(path.join(configDir, REPORTER_JS))
    : false;
  console.log(`settings file:    ${p}`);
  console.log(`hooks enabled:    ${hooks.enabled}`);
  console.log(
    `events wired:     ${found.length}/${EVENTS.length}` +
      (found.length === EVENTS.length ? "" : ` (${found.join(", ") || "none"})`)
  );
  console.log(`reporter present: ${reporterOk}`);
  if (found.length === EVENTS.length && hooks.enabled && reporterOk) {
    console.log("state: installed — restart zcode sessions to pick the hooks up");
  } else {
    console.log(
      "state: not fully installed — run herdr plugin action invoke herdr-zcode.install-hooks"
    );
  }
}

const action = process.argv[2] || "";
if (action === "install") install();
else if (action === "remove") remove();
else if (action === "status") status();
else fail(`unknown action '${action}'; expected install | remove | status`);
