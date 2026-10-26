/**
 * DeepSeek Search & Fetch tools for pi.
 *
 * Wraps the DeepSeek Search and Fetch APIs documented at
 * https://api-docs.deepseek.com/guides/search
 *
 * Tools:
 *   - deepseek_search: web search powered by DeepSeek's in-house engine
 *   - deepseek_fetch:  fetch a URL and return its content as Markdown
 *
 * The API key is read from DEEPSEEK_API_KEY, or from the `deepseek` entry in
 * ~/.pi/agent/auth.json (PI_CODING_AGENT_DIR is honored).
 *
 * Pricing (as of the docs): $0.75 per 1,000 successful requests.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const BASE_URL = "https://api.deepseek.com";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;
const SELF_PATH = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Subagent integration
// ---------------------------------------------------------------------------

/**
 * pi-interactive-subagents launches children with `--no-extensions` and grants
 * only the extensions backing an agent's tool list. Register this file as the
 * backing extension for its tools so agents can declare them in frontmatter.
 */
function registerForSubagents(): void {
	const registry = (globalThis as Record<string, { registerToolExtension?: (name: string, path: string) => void }>)
		.__pi_interactive_subagents;
	if (!registry?.registerToolExtension) return;
	for (const name of ["deepseek_search", "deepseek_fetch"]) {
		try {
			registry.registerToolExtension(name, SELF_PATH);
		} catch {
			// Another path already owns the name; keep the existing registration.
		}
	}
}

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function resolveCommandKey(command: string): string {
	const out = execFileSync("bash", ["-lc", command], { encoding: "utf-8" });
	return out.trim();
}

function getApiKey(): string {
	const fromEnv = process.env.DEEPSEEK_API_KEY?.trim();
	if (fromEnv) return fromEnv;

	const authPath = join(agentDir(), "auth.json");
	if (existsSync(authPath)) {
		try {
			const auth = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
			const entry = auth.deepseek as { key?: unknown } | undefined;
			if (typeof entry?.key === "string" && entry.key.trim()) {
				const key = entry.key.trim();
				if (key.startsWith("!")) return resolveCommandKey(key.slice(1));
				return key;
			}
		} catch {
			// fall through to the error below
		}
	}

	throw new Error(
		"No DeepSeek API key found. Set DEEPSEEK_API_KEY or run `/login` and pick DeepSeek (stores the key in auth.json).",
	);
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "DeepSeekApiError";
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Request aborted"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * The DeepSeek APIs return Markdown with punctuation over-escaped (`\/`, `\:`, `\.`).
 * Those backslashes add noise for the model, so drop the ones that carry no Markdown
 * meaning, while leaving fenced code blocks untouched.
 */
function unescapeMarkdown(text: string): string {
	let inFence = false;
	return text
		.split("\n")
		.map((line) => {
			if (/^\s{0,3}(```|~~~)/.test(line)) {
				inFence = !inFence;
				return line;
			}
			if (inFence) return line;
			return line.replace(/\\([/:,;'&@%"])/g, "$1");
		})
		.join("\n");
}

function parseErrorMessage(status: number, body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string } };
		if (parsed.error?.message) return `DeepSeek API error (${status}): ${parsed.error.message}`;
	} catch {
		// not JSON
	}
	const trimmed = body.trim().slice(0, 500);
	return `DeepSeek API error (${status})${trimmed ? `: ${trimmed}` : ""}`;
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
	const key = getApiKey();
	let lastError: unknown;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

		try {
			const response = await fetch(`${BASE_URL}${path}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${key}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: combined,
			});

			if (response.ok) return (await response.json()) as T;

			const text = await response.text();
			const error = new ApiError(response.status, parseErrorMessage(response.status, text));
			// Retry only idempotent, transient failures (the APIs are read-only).
			const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
			if (!retryable || attempt === MAX_RETRIES) throw error;
			lastError = error;
		} catch (error) {
			if (signal?.aborted) throw new Error("Request aborted");
			if (error instanceof ApiError) throw error;
			lastError = error;
			if (attempt === MAX_RETRIES) throw error;
		}

		await sleep(500 * 2 ** attempt, signal);
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ---------------------------------------------------------------------------
// Search API
// ---------------------------------------------------------------------------

interface SearchResult {
	rerank_score?: number;
	title?: string;
	url?: string;
	snippet?: string;
	summary?: string;
	content?: string;
	site_name?: string | null;
	site_icon?: string | null;
	date?: string | null;
	authority?: number;
}

interface SearchResponse {
	results?: SearchResult[];
}

const SearchParams = Type.Object({
	query: Type.String({
		description: "Search query (1-128 chars). Supports operators: site:, -site:, -, -\"phrase\", \"phrase\", lang:zh,en, after:2025-01-01, before:2026-06-01",
		minLength: 1,
		maxLength: 128,
	}),
	count: Type.Optional(
		Type.Integer({ description: "Number of results to return (1-50, default 10)", minimum: 1, maximum: 50 }),
	),
	ori_question: Type.Optional(
		Type.String({ description: "The user's original question, to improve query understanding (max 128 chars)" }),
	),
	need_content: Type.Optional(
		Type.Boolean({ description: "Return full page content for each result (larger responses, default false)" }),
	),
	localization: Type.Optional(
		Type.String({ description: "Optional IP address used to localize search results" }),
	),
});

interface SearchDetails {
	query: string;
	count: number;
	returned: number;
	urls: string[];
	truncated: boolean;
}

function formatSearchResults(results: SearchResult[], needContent: boolean): string {
	const blocks = results.map((result, index) => {
		const meta: string[] = [];
		if (result.site_name) meta.push(result.site_name);
		if (result.date) meta.push(result.date);
		if (typeof result.authority === "number" && result.authority >= 0) meta.push(`authority ${result.authority}/4`);
		if (typeof result.rerank_score === "number") meta.push(`score ${result.rerank_score.toFixed(2)}`);

		const lines = [`${index + 1}. ${result.title ?? "(untitled)"}`, `   ${result.url ?? "(no url)"}`];
		if (meta.length) lines.push(`   ${meta.join(" | ")}`);
		const summary = result.summary || result.snippet;
		if (summary) lines.push("", `   ${summary.replace(/\n/g, "\n   ")}`);
		if (needContent && result.content) {
			const cleaned = unescapeMarkdown(result.content);
			const body = cleaned.length > 8_000 ? `${cleaned.slice(0, 8_000)}\n   [...content truncated]` : cleaned;
			lines.push("", `   --- page content ---`, `   ${body.replace(/\n/g, "\n   ")}`);
		}
		return lines.join("\n");
	});

	return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// Fetch API
// ---------------------------------------------------------------------------

const FetchParams = Type.Object({
	url: Type.String({
		description: "HTTP(S) URL of the page to fetch (max 8192 chars, no credentials in the URL)",
		minLength: 1,
		maxLength: 8192,
	}),
});

interface FetchResponse {
	title?: string;
	content?: string;
}

interface FetchDetails {
	url: string;
	title: string;
	bytes: number;
	truncated: boolean;
	fullOutputPath?: string;
}

function saveFullOutput(content: string): string {
	const dir = join(tmpdir(), "pi-deepseek-fetch");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `fetch-${Date.now()}.md`);
	writeFileSync(file, content, "utf-8");
	return file;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function deepseekSearchExtension(pi: ExtensionAPI): void {
	registerForSubagents();
	// Re-run once every extension has loaded: the subagent registry is published
	// by another extension whose load order we do not control.
	pi.on("session_start", () => registerForSubagents());

	pi.registerTool({
		name: "deepseek_search",
		label: "DeepSeek Search",
		description: [
			"Search the live web with DeepSeek's search engine and return ranked results (title, URL, date, summary, optional page content).",
			"Supports operators such as site:, -site:, \"exact phrase\", -term, lang:zh,en, after:2025-01-01, before:2026-06-01.",
			"Use deepseek_fetch to read a specific page as Markdown.",
		].join(" "),
		promptSnippet: "Search the live web (DeepSeek Search API)",
		parameters: SearchParams,
		annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
		async execute(_toolCallId, params, signal, onUpdate): Promise<{ content: { type: "text"; text: string }[]; details: SearchDetails }> {
			const count = params.count ?? 10;
			onUpdate?.({ content: [{ type: "text", text: `Searching the web for "${params.query}"...` }], details: undefined });

			const response = await post<SearchResponse>(
				"/v1/tools/search",
				{
					query: params.query,
					count,
					...(params.ori_question ? { ori_question: params.ori_question } : {}),
					...(params.localization ? { localization: params.localization } : {}),
					need_content: params.need_content ?? false,
				},
				signal,
			);

			const results = Array.isArray(response.results) ? response.results : [];
			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No results found for "${params.query}".` }],
					details: { query: params.query, count, returned: 0, urls: [], truncated: false },
				};
			}

			const body = `Search results for "${params.query}" (${results.length}):\n\n${formatSearchResults(results, params.need_content ?? false)}`;
			const truncated = truncateHead(body, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			const text = truncated.truncated
				? `${truncated.content}\n\n[Output truncated to ${formatSize(DEFAULT_MAX_BYTES)} / ${DEFAULT_MAX_LINES} lines. Reduce count or set need_content=false for a smaller response.]`
				: truncated.content;

			return {
				content: [{ type: "text", text }],
				details: {
					query: params.query,
					count,
					returned: results.length,
					urls: results.map((r) => r.url).filter((url): url is string => Boolean(url)),
					truncated: truncated.truncated,
				},
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("deepseek_search ")) +
					theme.fg("accent", `"${args.query}"`) +
					theme.fg("dim", ` (${args.count ?? 10})`),
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "deepseek_fetch",
		label: "DeepSeek Fetch",
		description:
			"Fetch a single web page through the DeepSeek Fetch API and return its title and content converted to Markdown. Use after deepseek_search to read a result in full.",
		promptSnippet: "Fetch a web page as Markdown (DeepSeek Fetch API)",
		parameters: FetchParams,
		annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
		async execute(_toolCallId, params, signal, onUpdate): Promise<{ content: { type: "text"; text: string }[]; details: FetchDetails }> {
			onUpdate?.({ content: [{ type: "text", text: `Fetching ${params.url}...` }], details: undefined });

			const page = await post<FetchResponse>("/v1/tools/fetch", { url: params.url }, signal);
			let title = page.title ?? "";
			let content = page.content ?? "";

			if (!content.trim()) {
				throw new Error(`DeepSeek Fetch returned no content for ${params.url} (the site may block fetching or use an unsupported content type).`);
			}

			title = unescapeMarkdown(title);
			content = unescapeMarkdown(content);

			const header = title ? `# ${title}\n\nSource: ${params.url}\n\n` : `Source: ${params.url}\n\n`;
			const truncated = truncateHead(header + content, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			let text = truncated.content;
			let fullOutputPath: string | undefined;

			if (truncated.truncated) {
				fullOutputPath = saveFullOutput(header + content);
				text += `\n\n[Output truncated to ${formatSize(DEFAULT_MAX_BYTES)} / ${DEFAULT_MAX_LINES} lines. Full Markdown saved to ${fullOutputPath}]`;
			}

			return {
				content: [{ type: "text", text }],
				details: {
					url: params.url,
					title,
					bytes: Buffer.byteLength(content, "utf-8"),
					truncated: truncated.truncated,
					fullOutputPath,
				},
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("deepseek_fetch ")) + theme.fg("accent", args.url), 0, 0);
		},
	});
}
