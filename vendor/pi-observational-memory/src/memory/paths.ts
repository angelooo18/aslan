/**
 * `.memory/` substrate (Phase B). The filesystem IS the long-term recall interface: the master
 * reads topic files with ordinary `ls`/`read`/`grep`. Topic files are NOT rolled back by `/tree`
 * (they track the repo, not the session branch).
 *
 * Layout under <project>/.memory/<sessionId>/ (the per-session memory root):
 *   INDEX.md            — orchestrator-owned; (re)rendered from topic front-matter
 *   <topic>.md          — consolidator-authored; YAML front-matter + current-state prose
 *   JOURNEY.md          — consolidator-authored; running descriptive project history
 *   .runs/<id>.json     — transient worker IPC (not GC'd in v1)
 *
 * All writes are atomic (temp + rename) so a reader never sees a half-written file.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, basename, isAbsolute, join, relative, resolve } from "node:path";

export const INDEX_FILENAME = "INDEX.md";
/**
 * The running, whole-project descriptive history. Consolidator-authored prose (no front-matter),
 * pushed into every compaction block for orientation. Like INDEX.md it is a special file, NOT a
 * topic file: it is excluded from `listTopics`/the memory map and read verbatim at compaction.
 */
export const JOURNEY_FILENAME = "JOURNEY.md";

/** The project-level `.memory/` base. Per-session roots live one level below it. */
export function memoryBaseDir(cwd: string): string {
	return join(cwd, ".memory");
}

/**
 * The per-session memory root: `.memory/<sessionId>/`. All durable long-term memory (INDEX,
 * topic files, JOURNEY) and transient `.runs/` IPC are scoped under here so two sessions in the
 * same project never share consolidator output. Keyed by the immutable session header id
 * (survives /name, /resume, /tree) — NOT the session filename or display name.
 */
export function sessionMemoryRoot(cwd: string, sessionId: string): string {
	return join(memoryBaseDir(cwd), sessionId);
}

export function indexPath(root: string): string {
	return join(root, INDEX_FILENAME);
}

export function journeyPath(root: string): string {
	return join(root, JOURNEY_FILENAME);
}

/** Find a root entry by name, ignoring case (macOS/Windows FS and mixed-case legacy files). */
function findRootEntryCaseInsensitive(root: string, name: string): string | undefined {
	if (!existsSync(root)) return undefined;
	const lower = name.toLowerCase();
	try {
		const match = readdirSync(root).find((entry) => entry.toLowerCase() === lower);
		return match ? join(root, match) : undefined;
	} catch {
		return undefined;
	}
}

/** Read `JOURNEY.md` at the session memory root, trimmed. Returns undefined when missing or effectively empty. */
export function readJourney(root: string): string | undefined {
	const exact = journeyPath(root);
	const path = existsSync(exact) ? exact : findRootEntryCaseInsensitive(root, JOURNEY_FILENAME);
	if (!path) return undefined;
	try {
		const body = readFileSync(path, "utf-8").trim();
		return body.length > 0 ? body : undefined;
	} catch {
		return undefined;
	}
}

/** Atomic write (temp + rename). Creates parent dirs as needed. */
export function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, content, "utf-8");
	renameSync(tmp, path);
}

/**
 * Resolve a (possibly relative) path and confirm it stays inside the session memory root.
 * Returns the absolute path, or undefined if it escapes the sandbox. The consolidator's scoped
 * tools use this to reject any path outside the memory root (design risk 6).
 *
 * Every `.memory` path segment is dropped, wherever it appears, for backward compatibility with
 * older consolidator prompts and to prevent a model from recreating the nested reservation dir:
 * `.memory/auth.md`, `.memory/.memory/auth.md` and `topics/.memory/auth.md` all normalize to
 * paths inside the root (the worker's cwd is already the memory root).
 */
export function resolveWithinMemory(root: string, requestedPath: string): string | undefined {
	const base = resolve(root);
	const raw = requestedPath.replace(/\\/g, "/");
	// Absolute paths are never inside the sandbox, even after stripping .memory segments.
	if (isAbsolute(raw)) return undefined;
	const normalized = raw
		.split("/")
		.filter((part) => part !== "" && part !== "." && part.toLowerCase() !== ".memory")
		.join("/");
	const abs = resolve(base, normalized);
	const rel = relative(base, abs);
	if (rel === "" || rel === ".") return abs; // the session memory root itself
	if (rel.startsWith("..") || isAbsolute(rel) || resolve(base, rel) !== abs) return undefined;
	return abs;
}

/** Collect every Markdown file under a legacy nested tree, skipping transient .runs/ IPC. */
function collectMarkdownFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.toLowerCase() === ".runs") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) collectMarkdownFiles(full, out);
		else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(full);
	}
	return out;
}

/** Find the legacy nested reservation dir without assuming a specific case on Linux. */
function findLegacyNestedRoot(root: string): string | undefined {
	if (!existsSync(root)) return undefined;
	for (const name of readdirSync(root)) {
		if (name.toLowerCase() !== ".memory") continue;
		const full = join(root, name);
		try {
			if (statSync(full).isDirectory()) return full;
		} catch {
			/* ignore unreadable entries */
		}
	}
	return undefined;
}

/** First free destination: the original name, then `.legacy-<stamp>`, then `-1`, `-2`, ... */
function uniqueLegacyDestination(root: string, name: string, stamp: string): string {
	const base = name.slice(0, -3);
	let dst = join(root, name);
	if (!findRootEntryCaseInsensitive(root, name)) return dst;
	dst = join(root, `${base}.legacy-${stamp}.md`);
	for (let i = 1; findRootEntryCaseInsensitive(root, basename(dst)); i++) {
		dst = join(root, `${base}.legacy-${stamp}-${i}.md`);
	}
	return dst;
}

/**
 * Recover memory written by the old consolidator prompt, which told the worker to write under
 * `.memory/<topic>.md` even though its cwd was already `.memory/<sessionId>/`. That produced a
 * nested `<root>/.memory/` tree the index and compaction readers never see.
 *
 * Recursively lifts every `.md` file to the root, flattening subdirectories by basename and
 * resolving collisions with a unique `.legacy-<timestamp>[-n]` suffix. A root file always wins;
 * a nested INDEX.md is ignored (the orchestrator regenerates it) and a nested JOURNEY.md is
 * skipped when the root already has the current one. `.runs/` and non-Markdown files are left in
 * place, empty legacy directories are pruned, and the operation is idempotent.
 */
export function migrateLegacyNestedMemory(root: string): string[] {
	const nested = findLegacyNestedRoot(root);
	if (!nested) return [];

	const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
	const moved: string[] = [];
	for (const src of collectMarkdownFiles(nested)) {
		const name = basename(src);
		const lower = name.toLowerCase();
		const isJourney = lower === JOURNEY_FILENAME.toLowerCase();
		if (lower === INDEX_FILENAME.toLowerCase()) continue;
		if (isJourney && findRootEntryCaseInsensitive(root, JOURNEY_FILENAME)) continue;
		const normalizedName = isJourney
			? JOURNEY_FILENAME
			: lower.endsWith(".md")
				? `${name.slice(0, -3)}.md`
				: name;
		const dst = uniqueLegacyDestination(root, normalizedName, stamp);
		try {
			renameSync(src, dst);
			moved.push(dst);
		} catch {
			// Best effort: an odd/read-only filesystem must not break the session.
		}
	}

	// Prune empty legacy directories bottom-up; leave .runs/ and non-Markdown content alone.
	const prune = (dir: string): boolean => {
		let empty = true;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.name.toLowerCase() === ".runs") {
				empty = false;
			} else if (entry.isDirectory()) {
				if (!prune(full)) empty = false;
			} else {
				empty = false;
			}
		}
		if (empty) {
			try {
				rmdirSync(dir);
			} catch {
				/* ignore */
			}
		}
		return empty;
	};
	try {
		prune(nested);
	} catch {
		// Leave a non-empty/odd nested directory for inspection.
	}
	return moved;
}

export type TopicFrontMatter = {
	id?: string;
	title?: string;
	summary?: string;
	updated?: string;
};

export type Topic = TopicFrontMatter & {
	/** Path relative to the project root, e.g. ".memory/<sessionId>/auth.md". */
	path: string;
	/** Bare filename, e.g. "auth.md". */
	filename: string;
};

const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

/**
 * Parse leading YAML-ish front-matter. Intentionally tiny (no YAML dep): supports the flat
 * `key: value` fields the consolidator authors (id, title, summary, updated). Returns the
 * parsed fields plus the body after the front-matter block.
 */
export function parseFrontMatter(content: string): { front: TopicFrontMatter; body: string } {
	const match = FRONT_MATTER_RE.exec(content);
	if (!match) return { front: {}, body: content };
	const front: TopicFrontMatter = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx < 0) continue;
		const key = line.slice(0, idx).trim();
		let value = line.slice(idx + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key === "id" || key === "title" || key === "summary" || key === "updated") {
			front[key] = value;
		}
	}
	return { front, body: content.slice(match[0].length) };
}

/**
 * List parsed topic files (every `*.md` except INDEX.md/JOURNEY.md) under a session memory
 * root, sorted by filename. Each topic's `path` is rendered relative to the project cwd (e.g.
 * `.memory/<sessionId>/auth.md`) so the master can `read`/`grep` it directly from the map.
 */
export function listTopics(root: string): Topic[] {
	if (!existsSync(root)) return [];
	const cwd = resolve(root, "..", "..");
	const topics: Topic[] = [];
	for (const filename of readdirSync(root)) {
		const lower = filename.toLowerCase();
		if (!lower.endsWith(".md") || lower === INDEX_FILENAME.toLowerCase() || lower === JOURNEY_FILENAME.toLowerCase()) continue;
		let content: string;
		try {
			content = readFileSync(join(root, filename), "utf-8");
		} catch {
			continue;
		}
		const { front } = parseFrontMatter(content);
		topics.push({ ...front, path: relative(cwd, join(root, filename)), filename });
	}
	topics.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
	return topics;
}
