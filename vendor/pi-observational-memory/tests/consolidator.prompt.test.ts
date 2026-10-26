import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONSOLIDATOR_SYSTEM } from "../agent/consolidator/prompt.js";
import { buildConsolidatorPrompt } from "../src/hooks/consolidator-trigger.js";

let cwd: string;
let root: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "om-prompt-"));
	root = join(cwd, ".memory", "sess-1");
	mkdirSync(root, { recursive: true });
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

const observation = {
	timestamp: "2026-06-25T12:00:00",
	content: "The auth module uses JWT sessions.",
	tokenCount: 12,
};

describe("consolidator prompt paths", () => {
	it("tells the model to write in the current directory, not a nested .memory/", () => {
		const prompt = buildConsolidatorPrompt(root, [observation], 400);

		expect(prompt).toContain("in the current directory (the session memory root)");
		expect(prompt).toContain("do not create a nested .memory/ directory");
		expect(prompt).not.toContain("durable topic files under .memory/");
	});

	it("names JOURNEY.md at the root, not .memory/JOURNEY.md", () => {
		const prompt = buildConsolidatorPrompt(root, [observation], 400);

		expect(prompt).toContain("CURRENT JOURNEY (JOURNEY.md");
		expect(prompt).not.toContain("CURRENT JOURNEY (.memory/JOURNEY.md");
		expect(prompt).toContain("JOURNEY.md per your instructions");
		expect(prompt).not.toContain(".memory/JOURNEY.md per your instructions");
	});

	it("the system prompt no longer directs writes under .memory/", () => {
		expect(CONSOLIDATOR_SYSTEM).not.toContain(".memory/");
		expect(CONSOLIDATOR_SYSTEM).toContain("current directory (the session memory root)");
		expect(CONSOLIDATOR_SYSTEM).toContain("JOURNEY.md");
	});
});
