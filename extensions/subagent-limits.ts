/**
 * Subagent guardrails for pi-interactive-subagents.
 *
 * Enforces policy the upstream package does not: a cap on live child agents,
 * a burst cap per turn, and a maximum tree depth. Configuration lives in
 * ~/.pi/agent/subagent-limits.json (PI_CODING_AGENT_DIR is honored) and is
 * re-read on every spawn, so tuning needs no restart.
 *
 * Depth: child sessions record `parentSession` in their header, so this
 * extension walks that chain to learn how deep it is. To have the guard load
 * inside a spawning child (children run with --no-extensions), list the
 * `subagent_limits` tool in that agent's tools: it registers this file as the
 * tool's backing extension.
 */

import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const SELF_PATH = fileURLToPath(import.meta.url);
const SPAWN_TOOL = "subagent";
const STATUS_TOOL = "subagent_limits";
/** Published by pi-interactive-subagents; returns this process's live child count. */
const RUNNING_CHILDREN_KEY = Symbol.for("pi-subagents/running-children-count");

interface LimitsConfig {
	enabled: boolean;
	maxConcurrentSubagents: number;
	maxSpawnPerTurn: number;
	maxDepth: number;
}

const DEFAULTS: LimitsConfig = {
	enabled: true,
	maxConcurrentSubagents: 6,
	maxSpawnPerTurn: 3,
	maxDepth: 2,
};

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function readConfig(): LimitsConfig {
	const config = { ...DEFAULTS };
	const path = join(agentDir(), "subagent-limits.json");
	if (!existsSync(path)) return config;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<LimitsConfig>;
		if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
		for (const key of ["maxConcurrentSubagents", "maxSpawnPerTurn", "maxDepth"] as const) {
			const value = raw[key];
			if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
				config[key] = Math.floor(value);
			}
		}
	} catch {
		// Malformed config: fail open with defaults rather than blocking all work.
	}
	return config;
}

function runningChildren(): number {
	const fn = (globalThis as Record<symbol, unknown>)[RUNNING_CHILDREN_KEY];
	return typeof fn === "function" ? (fn as () => number)() : 0;
}

/** Count how many subagent sessions above this one (0 = top level). */
function findParentArtifactDir(artifactsRoot: string, childId: string): string | null {
	let entries: Dirent[];
	try {
		entries = readdirSync(artifactsRoot, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = join(artifactsRoot, entry.name);
		try {
			const scripts = readdirSync(join(dir, "subagent-scripts"));
			if (scripts.some((file) => file.endsWith(`-${childId}.sh`))) return dir;
		} catch {
			// No scripts dir in this artifact folder.
		}
	}
	return null;
}

/** Recover a session's spawn id from its filename (`<timestamp>_<id>-...`). */
function spawnIdFromSessionFile(sessionDir: string, sessionId: string): string | null {
	try {
		const file = readdirSync(sessionDir).find((name) => name.includes(sessionId) && name.endsWith(".jsonl"));
		if (!file) return null;
		return file.match(/_([0-9a-f]{8})-/)?.[1] ?? null;
	} catch {
		return null;
	}
}

/**
 * pi rewrites a seeded child session header on open, dropping `parentSession`,
 * so lineage comes from the spawn artifacts instead: each spawn writes
 * `artifacts/<parent session id>/subagent-scripts/<name>-<child id>.sh`.
 * Walk that chain upward until no parent artifact dir matches.
 *
 * Known edge: a role folder with its own cwd uses a different session dir, so
 * the chain stops early and the guard fails open (depth 0).
 */
function computeDepth(sessionDir: string | null, subagentId: string | undefined): number {
	if (!sessionDir || !subagentId) return 0;
	const artifactsRoot = join(sessionDir, "artifacts");
	let depth = 0;
	let currentId = subagentId;
	const seen = new Set<string>();
	while (depth < 20 && !seen.has(currentId)) {
		seen.add(currentId);
		const parentDir = findParentArtifactDir(artifactsRoot, currentId);
		if (!parentDir) break;
		depth++;
		const parentSpawnId = spawnIdFromSessionFile(sessionDir, basename(parentDir));
		if (!parentSpawnId) break;
		currentId = parentSpawnId;
	}
	return depth;
}

export default function subagentLimits(pi: ExtensionAPI): void {
	let depth = 0;
	let spawnsThisTurn = 0;
	/** Spawn calls allowed in this turn whose child is not registered yet. */
	const reserved = new Set<string>();
	let config = readConfig();

	function registerForSubagents(): void {
		const registry = (globalThis as { __pi_interactive_subagents?: { registerToolExtension?: (name: string, path: string) => void } })
			.__pi_interactive_subagents;
		if (!registry?.registerToolExtension) return;
		try {
			registry.registerToolExtension(STATUS_TOOL, SELF_PATH);
		} catch {
			// Another path already owns the name.
		}
	}

	registerForSubagents();

	pi.on("session_start", (_event, ctx) => {
		config = readConfig();
		depth = computeDepth(ctx.sessionManager.getSessionDir(), process.env.PI_SUBAGENT_ID);
		spawnsThisTurn = 0;
		reserved.clear();
		registerForSubagents();
	});

	pi.on("turn_start", () => {
		spawnsThisTurn = 0;
	});

	pi.on("tool_call", (event) => {
		if (event.toolName !== SPAWN_TOOL) return;
		config = readConfig();
		if (!config.enabled) return;

		if (depth + 1 > config.maxDepth) {
			return {
				block: true,
				reason:
					`Blocked by subagent-limits: this session is at depth ${depth}, so spawning would exceed maxDepth ${config.maxDepth}. ` +
					`Do the work here, or raise maxDepth in ${join(agentDir(), "subagent-limits.json")}.`,
			};
		}

		const live = runningChildren() + reserved.size;
		if (live >= config.maxConcurrentSubagents) {
			return {
				block: true,
				reason:
					`Blocked by subagent-limits: ${live} subagent(s) already running (maxConcurrentSubagents ${config.maxConcurrentSubagents}). ` +
					`Wait for one to report back, or raise the cap in ${join(agentDir(), "subagent-limits.json")}.`,
			};
		}

		if (spawnsThisTurn >= config.maxSpawnPerTurn) {
			return {
				block: true,
				reason:
					`Blocked by subagent-limits: ${spawnsThisTurn} spawn(s) already this turn (maxSpawnPerTurn ${config.maxSpawnPerTurn}). ` +
					`Spread spawns across turns or raise the cap in ${join(agentDir(), "subagent-limits.json")}.`,
			};
		}

		spawnsThisTurn++;
		reserved.add(event.toolCallId);
	});

	pi.on("tool_execution_end", (event) => {
		reserved.delete(event.toolCallId);
	});

	pi.registerTool({
		name: STATUS_TOOL,
		label: "Subagent Limits",
		description:
			"Report this session's subagent limits and current usage: tree depth, running children, spawns used this turn.",
		promptSnippet: "Show subagent depth and remaining spawn budget",
		parameters: Type.Object({}),
		annotations: { readOnlyHint: true, idempotentHint: true },
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const current = readConfig();
			const live = runningChildren();
			const text = [
				`enabled: ${current.enabled}`,
				`depth: ${depth} (maxDepth ${current.maxDepth})`,
				`running children: ${live} + ${reserved.size} reserved (maxConcurrentSubagents ${current.maxConcurrentSubagents})`,
				`spawns this turn: ${spawnsThisTurn} (maxSpawnPerTurn ${current.maxSpawnPerTurn})`,
			].join("\n");
			return {
				content: [{ type: "text" as const, text }],
				details: { depth, live, reserved: reserved.size, spawnsThisTurn, config: current },
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("subagent_limits")), 0, 0);
		},
	});
}
