import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerConsolidatorTools } from "../agent/consolidator/tools.js";
import { migrateLegacyNestedMemory } from "../src/memory/paths.js";

let cwd: string;
let root: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "om-consolidator-"));
	root = join(cwd, ".memory", "sess-1");
	mkdirSync(root, { recursive: true });
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function write(relativePath: string, content: string): void {
	const path = join(root, relativePath);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf-8");
}

function registerTools(): Record<string, { execute: (id: string, params: any) => Promise<any> }> {
	const tools: Record<string, any> = {};
	registerConsolidatorTools({ registerTool: (tool: any) => { tools[tool.name] = tool; } } as any, root);
	return tools;
}

describe("consolidator tools write to the session memory root", () => {
	it("normalizes a legacy .memory/ prefix instead of creating a nested directory", async () => {
		const tools = registerTools();
		const result = await tools.write.execute("w1", { path: ".memory/roman-history.md", content: "body" });
		expect(result.details?.error).toBeUndefined();
		expect(readFileSync(join(root, "roman-history.md"), "utf-8")).toBe("body");
		expect(existsSync(join(root, ".memory", "roman-history.md"))).toBe(false);
	});

	it("still rejects paths that escape the memory root", async () => {
		const tools = registerTools();
		const result = await tools.write.execute("w2", { path: "../escape.md", content: "nope" });
		expect(result.details?.error).toBe(true);
		expect(existsSync(join(cwd, "escape.md"))).toBe(false);
	});

	it("keeps INDEX.md orchestrator-owned", async () => {
		const tools = registerTools();
		const result = await tools.write.execute("w3", { path: "INDEX.md", content: "# fake index" });
		expect(result.details?.error).toBe(true);
		expect(existsSync(join(root, "INDEX.md"))).toBe(false);
	});

	it("reads the same normalized path it wrote", async () => {
		const tools = registerTools();
		await tools.write.execute("w4", { path: ".memory/auth.md", content: "auth body" });
		const result = await tools.read.execute("r1", { path: ".memory/auth.md" });
		expect(result.content[0].text).toBe("auth body");
	});

	it("rejects subdirectory writes because listTopics only indexes the root", async () => {
		const tools = registerTools();
		const result = await tools.write.execute("w5", { path: "topics/auth.md", content: "body" });
		expect(result.details?.error).toBe(true);
		expect(existsSync(join(root, "topics", "auth.md"))).toBe(false);
	});
});

describe("migrateLegacyNestedMemory", () => {
	it("moves topic and JOURNEY files from <root>/.memory/ up to the root", () => {
		write(".memory/roman.md", "---\nid: roman\n---\nbody");
		write(".memory/JOURNEY.md", "## history");

		const moved = migrateLegacyNestedMemory(root);

		expect(moved.sort()).toEqual([join(root, "JOURNEY.md"), join(root, "roman.md")].sort());
		expect(readFileSync(join(root, "roman.md"), "utf-8")).toContain("body");
		expect(readFileSync(join(root, "JOURNEY.md"), "utf-8")).toBe("## history");
		expect(existsSync(join(root, ".memory"))).toBe(false);
	});

	it("is collision-safe: an existing root file wins", () => {
		write("roman.md", "root version");
		write(".memory/roman.md", "nested version");

		const moved = migrateLegacyNestedMemory(root);

		expect(readFileSync(join(root, "roman.md"), "utf-8")).toBe("root version");
		expect(moved).toHaveLength(1);
		expect(moved[0]).toMatch(/roman\.legacy-\d+\.md$/);
		expect(readFileSync(moved[0], "utf-8")).toBe("nested version");
	});

	it("leaves .runs in place and is idempotent", () => {
		write(".memory/roman.md", "body");
		mkdirSync(join(root, ".memory", ".runs"), { recursive: true });
		writeFileSync(join(root, ".memory", ".runs", "obs-1.json"), "{}", "utf-8");

		migrateLegacyNestedMemory(root);

		expect(existsSync(join(root, "roman.md"))).toBe(true);
		expect(existsSync(join(root, ".memory", ".runs", "obs-1.json"))).toBe(true);
		expect(migrateLegacyNestedMemory(root)).toEqual([]);
		expect(readdirSync(join(root, ".memory"))).toEqual([".runs"]);
	});

	it("recursively flattens markdown from legacy subdirectories", () => {
		write(".memory/topics/auth.md", "sub auth");

		const moved = migrateLegacyNestedMemory(root);

		expect(moved).toEqual([join(root, "auth.md")]);
		expect(readFileSync(join(root, "auth.md"), "utf-8")).toBe("sub auth");
		expect(existsSync(join(root, ".memory"))).toBe(false);
	});

	it("assigns unique legacy names when several nested files collide with the root", () => {
		write("roman.md", "root version");
		write(".memory/a/roman.md", "a version");
		write(".memory/b/roman.md", "b version");

		const moved = migrateLegacyNestedMemory(root);

		expect(moved).toHaveLength(2);
		expect(new Set(moved).size).toBe(2);
		expect(moved.map((f) => readFileSync(f, "utf-8")).sort()).toEqual(["a version", "b version"]);
		expect(readFileSync(join(root, "roman.md"), "utf-8")).toBe("root version");
	});

	it("does not import a nested INDEX.md and keeps the current root JOURNEY.md", () => {
		write("INDEX.md", "root index");
		write("JOURNEY.md", "root journey");
		write(".memory/INDEX.md", "stale nested index");
		write(".memory/JOURNEY.md", "stale nested journey");
		write(".memory/auth.md", "auth body");

		const moved = migrateLegacyNestedMemory(root);

		expect(moved).toEqual([join(root, "auth.md")]);
		expect(readFileSync(join(root, "INDEX.md"), "utf-8")).toBe("root index");
		expect(readFileSync(join(root, "JOURNEY.md"), "utf-8")).toBe("root journey");
		expect(existsSync(join(root, ".memory", "INDEX.md"))).toBe(true);
		expect(existsSync(join(root, ".memory", "JOURNEY.md"))).toBe(true);
	});

	it("finds a .MEMORY directory and normalizes uppercase .MD on case-sensitive FS", () => {
		write(".MEMORY/X.MD", "upper extension");

		const moved = migrateLegacyNestedMemory(root);

		expect(moved).toEqual([join(root, "X.md")]);
		expect(readFileSync(join(root, "X.md"), "utf-8")).toBe("upper extension");
		expect(existsSync(join(root, ".MEMORY"))).toBe(false);
	});

	it("skips uppercase INDEX/JOURNEY in a legacy tree when the root already owns them", () => {
		write("JOURNEY.md", "root journey");
		write(".MEMORY/INDEX.MD", "stale index");
		write(".MEMORY/JOURNEY.MD", "stale journey");

		const moved = migrateLegacyNestedMemory(root);

		expect(moved).toEqual([]);
		expect(readFileSync(join(root, "JOURNEY.md"), "utf-8")).toBe("root journey");
		expect(existsSync(join(root, ".MEMORY", "INDEX.MD"))).toBe(true);
		expect(existsSync(join(root, ".MEMORY", "JOURNEY.MD"))).toBe(true);
	});

	it("normalizes a mixed-case nested JOURNEY when the root has none", () => {
		write(".memory/Journey.Md", "## legacy journey");

		const moved = migrateLegacyNestedMemory(root);

		expect(moved).toEqual([join(root, "JOURNEY.md")]);
		expect(readFileSync(join(root, "JOURNEY.md"), "utf-8")).toBe("## legacy journey");
	});

	it("treats case-variant root filenames as collisions", () => {
		write("auth.md", "root version");
		write(".MEMORY/AUTH.MD", "legacy version");

		const moved = migrateLegacyNestedMemory(root);

		expect(moved).toHaveLength(1);
		expect(moved[0]).toMatch(/AUTH\.legacy-\d+\.md$/);
		expect(readFileSync(join(root, "auth.md"), "utf-8")).toBe("root version");
		expect(readFileSync(moved[0], "utf-8")).toBe("legacy version");
	});
});
