/**
 * Permission gate — human approval for consequential actions.
 *
 * Intercepts tool calls before they run. Commands that can destroy data,
 * escalate privileges, publish, deploy, or exfiltrate credentials require an
 * explicit decision:
 *
 *   Allow once   → this call only
 *   Allow for session → this rule for the rest of the session
 *   Deny         → blocked, the model gets a reason
 *
 * Headless sessions (subagents) have no UI, so by default they are denied
 * (`headless: "deny"`). `~/.pi/agent/permissions.json` controls the policy:
 *
 *   {
 *     "enabled": true,
 *     "headless": "deny",          // "deny" | "allow"
 *     "auditLog": true,
 *     "allow": ["^git push --force-with-lease"]   // regex allowlist
 *   }
 *
 * Decisions are appended to ~/.pi/agent/permissions-audit.jsonl.
 *
 * To load this gate inside a shell-capable subagent, that agent's tools list
 * must include `permissions_status`; the extension registers itself as that
 * tool's backing extension.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SELF_PATH = fileURLToPath(import.meta.url);
const STATUS_TOOL = "permissions_status";

interface PermissionsConfig {
	enabled: boolean;
	headless: "deny" | "allow";
	auditLog: boolean;
	allow: string[];
}

const DEFAULTS: PermissionsConfig = {
	enabled: true,
	headless: "deny",
	auditLog: true,
	allow: [],
};

const SAFE_RM_DIRS = new Set([
	"node_modules",
	"dist",
	"build",
	"out",
	"target",
	"coverage",
	".cache",
	".next",
	".nuxt",
	".svelte-kit",
	".turbo",
	".parcel-cache",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	"tmp",
	"temp",
]);

const SENSITIVE_PATHS = [
	join(homedir(), ".ssh"),
	join(homedir(), ".gnupg"),
	join(homedir(), ".aws"),
	join(homedir(), ".config", "systemd"),
	join(homedir(), ".config", "autostart"),
	join(homedir(), ".pi", "agent", "auth.json"),
	join(homedir(), ".bashrc"),
	join(homedir(), ".zshrc"),
	join(homedir(), ".profile"),
	"/etc",
	"/bin",
	"/sbin",
	"/usr",
	"/boot",
];

interface Hit {
	rule: string;
	reason: string;
	detail: string;
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/**
 * Subagent panes are real TUI sessions (hasUI is true), but their permission
 * dialog is in a pane the user is not watching. Treat them as headless: deny
 * by policy instead of leaving a tool call waiting on an unseen prompt.
 */
function isSubagentSession(): boolean {
	return Boolean(process.env.PI_SUBAGENT_SESSION || process.env.PI_SUBAGENT_NAME);
}

function readConfig(): PermissionsConfig {
	const config: PermissionsConfig = { ...DEFAULTS, allow: [] };
	const path = join(agentDir(), "permissions.json");
	if (!existsSync(path)) return config;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PermissionsConfig>;
		if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
		if (raw.headless === "allow" || raw.headless === "deny") config.headless = raw.headless;
		if (typeof raw.auditLog === "boolean") config.auditLog = raw.auditLog;
		if (Array.isArray(raw.allow)) {
			config.allow = raw.allow.filter((value): value is string => typeof value === "string" && value.length > 0);
		}
	} catch {
		// Malformed config: fail closed on the built-in rules, not open.
	}
	return config;
}

function redact(text: string): string {
	return text
		.replace(/((?:token|secret|password|passwd|api[_-]?key)\s*[=:]\s*)(\S+)/gi, "$1[redacted]")
		.replace(/(Bearer\s+)\S+/gi, "$1[redacted]")
		.replace(/(Authorization:\s*)\S+/gi, "$1[redacted]");
}

function truncate(text: string, max = 300): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (quote) {
			if (ch === quote) quote = null;
			else if (ch === "\\" && i + 1 < input.length) current += input[++i];
			else current += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
		} else if (ch === "\\" && i + 1 < input.length) {
			current += input[++i];
		} else if (/\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
		} else {
			current += ch;
		}
	}
	if (current) tokens.push(current);
	return tokens;
}

function isSafeRmTarget(target: string): boolean {
	const cleaned = target.replace(/^['"]|['"]$/g, "").replace(/\/+$/, "").replace(/^\.\//, "");
	if (!cleaned || cleaned === "." || cleaned === "..") return false;
	if (cleaned.startsWith("~") || cleaned.includes("$") || cleaned.includes("`")) return false;
	if (cleaned.includes("*") || cleaned.includes("?")) return false;
	if (cleaned.startsWith("/")) return isInside(cleaned, tmpdir());
	const first = cleaned.split("/").filter(Boolean)[0];
	return SAFE_RM_DIRS.has(first);
}

/** Recursive deletes are fine on build artifacts, not on arbitrary paths. */
function classifyRm(command: string): Hit | null {
	for (const segment of command.split(/\n|&&|\|\||;|\|/)) {
		const tokens = tokenize(segment.trim());
		const rmIndex = tokens.findIndex((token) => token === "rm" || token.endsWith("/rm"));
		if (rmIndex === -1) continue;
		const args = tokens.slice(rmIndex + 1);
		const flags = args.filter((arg) => arg.startsWith("-") && arg !== "--");
		const recursive = flags.some((flag) => flag === "--recursive" || /^-[A-Za-z]*[rR]/.test(flag));
		if (!recursive) continue;
		const targets = args.filter((arg) => !arg.startsWith("-"));
		if (targets.length === 0) {
			return { rule: "rm", reason: "recursive delete without an explicit target", detail: segment.trim() };
		}
		if (targets.every(isSafeRmTarget)) continue;
		return {
			rule: "rm",
			reason: `recursive delete of ${targets.join(", ")}`,
			detail: segment.trim(),
		};
	}
	return null;
}

const COMMAND_RULES: Array<{ rule: string; reason: string; pattern: RegExp }> = [
	{ rule: "sudo", reason: "privilege escalation", pattern: /\b(?:sudo|doas)\s/ },
	{
		rule: "remote-code",
		reason: "piping a download into a shell",
		pattern: /\b(?:curl|wget)\b[^\n|;]*\|\s*(?:sudo\s+)?(?:bash|sh|zsh|fish)\b/,
	},
	{ rule: "mkfs", reason: "formatting a filesystem", pattern: /\bmkfs(?:\.[a-z0-9]+)?\b/ },
	{ rule: "dd-device", reason: "writing raw data to a device", pattern: /\bdd\b[^\n]*\bof=\/dev\// },
	{ rule: "fork-bomb", reason: "fork bomb", pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
	{
		rule: "power",
		reason: "powering off or rebooting the machine",
		pattern: /\b(?:shutdown|reboot|poweroff|halt)\b|\bsystemctl\s+(?:poweroff|reboot|halt)\b/,
	},
	{ rule: "kill-init", reason: "killing PID 1", pattern: /\bkill\s+(?:-9|-KILL)\s+1\b/ },
	{
		rule: "git-force-push",
		reason: "force-pushing a branch",
		pattern: /\bgit\s+push\b[^\n]*(?:--force(?!-with-lease)|(?:^|\s)-f(?:\s|$))/,
	},
	{ rule: "git-reset-hard", reason: "discarding uncommitted work", pattern: /\bgit\s+reset\s+--hard\b/ },
	{ rule: "git-clean", reason: "deleting untracked files", pattern: /\bgit\s+clean\s+-[A-Za-z]*[fdx]/ },
	{
		rule: "publish",
		reason: "publishing a package",
		pattern: /\b(?:npm|yarn|pnpm|cargo)\s+publish\b|\b(?:twine|pip)\s+upload\b/,
	},
	{
		rule: "deploy",
		reason: "deploying or destroying infrastructure",
		pattern:
			/\b(?:kubectl\s+(?:delete|drain)|helm\s+(?:uninstall|delete)|terraform\s+(?:destroy|apply)|fly\s+deploy|vercel\b[^\n]*--prod|netlify\s+deploy\b[^\n]*--prod|aws\b[^\n]*\bdelete-|gcloud\b[^\n]*\bdelete)\b/,
	},
	{ rule: "chmod-root", reason: "changing permissions recursively on /", pattern: /\bchmod\s+-R\s+777\s+\/(?:\s|$)/ },
	{
		rule: "shell-sensitive-write",
		reason: "writing to a sensitive path via shell",
		pattern:
			/(?:^|[;&|]\s*)(?:cp|mv|install|tee|sed\s+-i)\b[^\n]*(?:\/etc\/|~\/\.ssh|~\/\.gnupg|~\/\.aws|\/usr\/|\/bin\/|\/boot\/)/,
	},
	{
		rule: "redirect-sensitive",
		reason: "redirecting output into a sensitive path",
		pattern: /(?:>|>>)\s*(?:\/etc\/|~\/\.ssh|~\/\.gnupg|~\/\.aws|\/usr\/|\/bin\/|\/boot\/)/,
	},
	{
		rule: "exfil",
		reason: "sending local credentials over the network",
		pattern:
			/\b(?:curl|wget|nc|ncat)\b[^\n]*(?:auth\.json|id_rsa|\.ssh\b|\.aws\/credentials|\.env\b|token|api[_-]?key)/i,
	},
];

function classifyBash(command: string): Hit | null {
	const normalized = command.replace(/\\\n/g, " ");
	const rm = classifyRm(normalized);
	if (rm) return rm;
	for (const rule of COMMAND_RULES) {
		if (rule.pattern.test(normalized)) {
			return { rule: rule.rule, reason: rule.reason, detail: truncate(normalized) };
		}
	}
	return null;
}

function isInside(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function classifyPath(inputPath: string, cwd: string): Hit | null {
	if (!inputPath) return null;
	const absolute = resolve(cwd, inputPath);
	for (const sensitive of SENSITIVE_PATHS) {
		if (isInside(absolute, sensitive)) {
			return { rule: "write-sensitive", reason: `writing to a sensitive path (${sensitive})`, detail: absolute };
		}
	}
	const inTmp = isInside(absolute, tmpdir()) || isInside(absolute, "/tmp");
	if (inTmp || isInside(absolute, resolve(cwd))) return null;
	return { rule: "write-outside", reason: "writing outside the project directory", detail: absolute };
}

function classify(event: { toolName: string; input: Record<string, unknown> }, cwd: string): Hit | null {
	if (event.toolName === "bash" || event.toolName === "safe_bash") {
		const command = typeof event.input.command === "string" ? event.input.command : "";
		return command ? classifyBash(command) : null;
	}
	if (event.toolName === "write" || event.toolName === "edit") {
		const path = typeof event.input.path === "string" ? event.input.path : "";
		return path ? classifyPath(path, cwd) : null;
	}
	return null;
}

function matchesAllowlist(config: PermissionsConfig, tool: string, detail: string): boolean {
	const target = `${tool}: ${detail}`;
	for (const pattern of config.allow) {
		try {
			if (new RegExp(pattern, "i").test(target)) return true;
		} catch {
			// Ignore invalid patterns rather than failing every call.
		}
	}
	return false;
}

function audit(entry: Record<string, unknown>): void {
	const config = readConfig();
	if (!config.auditLog) return;
	try {
		appendFileSync(join(agentDir(), "permissions-audit.jsonl"), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
	} catch {
		// Best effort; never fail a tool call because logging failed.
	}
}

export default function permissions(pi: ExtensionAPI): void {
	const sessionRules = new Set<string>();

	function registerForSubagents(): void {
		const registry = (globalThis as {
			__pi_interactive_subagents?: { registerToolExtension?: (name: string, path: string) => void };
		}).__pi_interactive_subagents;
		if (!registry?.registerToolExtension) return;
		try {
			registry.registerToolExtension(STATUS_TOOL, SELF_PATH);
		} catch {
			// Another path already owns the name.
		}
	}

	registerForSubagents();

	pi.on("session_start", () => {
		sessionRules.clear();
		registerForSubagents();
	});

	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		const config = readConfig();
		if (!config.enabled) return;
		const hit = classify({ toolName: event.toolName, input: event.input }, ctx.cwd);
		if (!hit) return;

		const base = {
			ts: new Date().toISOString(),
			session: ctx.sessionManager.getSessionId(),
			tool: event.toolName,
			rule: hit.rule,
			reason: hit.reason,
			detail: redact(truncate(hit.detail, 500)),
		};

		if (matchesAllowlist(config, event.toolName, hit.detail)) {
			audit({ ...base, decision: "allow", source: "allowlist" });
			return;
		}
		if (sessionRules.has(hit.rule)) {
			audit({ ...base, decision: "allow", source: "session" });
			return;
		}

		if (!ctx.hasUI || isSubagentSession()) {
			if (config.headless === "allow") {
				audit({ ...base, decision: "allow", source: "headless-policy" });
				return;
			}
			audit({ ...base, decision: "deny", source: "headless" });
			return {
				block: true,
				reason:
					`Blocked by permissions (${hit.rule}): ${hit.reason}. This session has no UI to ask, ` +
					`so the action was denied. Run it yourself, or add an allow pattern to ${join(agentDir(), "permissions.json")}.`,
			};
		}

		const choice = await ctx.ui.select(
			"Permission required",
			["Allow once", "Allow for session", "Deny"],
		);

		if (choice === "Allow once") {
			audit({ ...base, decision: "allow", source: "user-once" });
			return;
		}
		if (choice === "Allow for session") {
			sessionRules.add(hit.rule);
			audit({ ...base, decision: "allow", source: "user-session" });
			return;
		}

		audit({ ...base, decision: "deny", source: choice ? "user" : "dismissed" });
		return {
			block: true,
			reason: `Blocked by permissions (${hit.rule}): ${hit.reason}.`,
		};
	});

	pi.registerTool({
		name: STATUS_TOOL,
		label: "Permissions",
		description:
			"Report the active permission policy (enabled, headless mode, allowlist entries) and the rules approved for this session.",
		promptSnippet: "Show the permission gate policy",
		parameters: Type.Object({}),
		annotations: { readOnlyHint: true, idempotentHint: true },
		async execute() {
			const config = readConfig();
			const text = [
				`enabled: ${config.enabled}`,
				`headless: ${config.headless}`,
				`allowlist patterns: ${config.allow.length}`,
				`session-approved rules: ${sessionRules.size > 0 ? [...sessionRules].join(", ") : "(none)"}`,
				`audit log: ${config.auditLog ? join(agentDir(), "permissions-audit.jsonl") : "disabled"}`,
			].join("\n");
			return { content: [{ type: "text" as const, text }], details: { config, sessionRules: [...sessionRules] } };
		},
	});
}
