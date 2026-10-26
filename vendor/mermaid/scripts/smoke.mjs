#!/usr/bin/env node
/**
 * Smoke test for the mermaid extension. Calls the tool directly — no model in
 * the loop — in a throwaway cwd, and checks every output format plus the error
 * paths.
 *
 *   npm run smoke
 */

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const workdir = mkdtempSync(join(tmpdir(), "mermaid-smoke-"))
process.chdir(workdir)

const { default: extension } = await import("../index.ts")

const tools = {}
extension({ registerTool: (tool) => (tools[tool.name] = tool), on: () => {} })

let failures = 0
function check(label, ok, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`)
  if (!ok) failures++
}
const saved = () => {
  try {
    return readdirSync(join(workdir, "viz"))
  } catch {
    return []
  }
}
const images = (result) => result.content.filter((part) => part.type === "image")

const source = ["graph TD", "  A[axiom] --> B[derived fact]", "  A --> C[lemma]", "  B --> D[theorem]", "  C --> D", ""].join("\n")

check("registers render_mermaid", typeof tools.render_mermaid?.execute === "function")

const preview = await tools.render_mermaid.execute("1", { source })
check("png preview returns an image", images(preview).length === 1)
check("png preview is image/png", images(preview)[0]?.mimeType === "image/png")
check("preview writes nothing to the project", saved().length === 0)
check("preview reports no save", /preview only/.test(preview.content[0].text))

const png = await tools.render_mermaid.execute("2", { source, save_as: "Dependency Graph" })
check("png save_as writes a .png", saved().filter((f) => /^mermaid-dependency-graph-\d+\.png$/.test(f)).length === 1)

const svg = await tools.render_mermaid.execute("3", { source, format: "svg", save_as: "vector" })
check("svg save_as writes a .svg", saved().some((f) => /^mermaid-vector-\d+\.svg$/.test(f)))
check("svg returns a raster preview", images(svg)[0]?.mimeType === "image/png")
const svgFile = saved().find((f) => /^mermaid-vector-\d+\.svg$/.test(f))
check("svg file is real SVG markup", readFileSync(join(workdir, "viz", svgFile), "utf8").trimStart().startsWith("<svg"))

const jpg = await tools.render_mermaid.execute("4", { source, format: "jpg", save_as: "photo", background: "transparent" })
check("jpg save_as writes a .jpg", saved().some((f) => /^mermaid-photo-\d+\.jpg$/.test(f)))
check("jpg returns image/jpeg", images(jpg)[0]?.mimeType === "image/jpeg")
const jpgFile = saved().find((f) => /^mermaid-photo-\d+\.jpg$/.test(f))
const jpgBytes = readFileSync(join(workdir, "viz", jpgFile))
check("jpg is real JPEG data", jpgBytes[0] === 0xff && jpgBytes[1] === 0xd8 && jpgBytes[2] === 0xff)

writeFileSync(join(workdir, "local.mmd"), source)
const fromFile = await tools.render_mermaid.execute("5", { file: "local.mmd" })
check("renders from a .mmd file", images(fromFile).length === 1)

const invalid = await tools.render_mermaid.execute("6", { source: "graph TD\n  A -->" })
check("bad syntax reports an error, not an image", invalid.isError === true && images(invalid).length === 0)

for (const [label, params] of [
  ["unknown format", { source, format: "gif" }],
  ["missing source", {}],
  ["missing file", { file: "nope.mmd" }],
]) {
  try {
    await tools.render_mermaid.execute("7", params)
    check(`rejects ${label}`, false)
  } catch (error) {
    check(`rejects ${label}`, /format|source|no such file/.test(error.message), error.message.slice(0, 60))
  }
}

console.log(failures === 0 ? `\nAll checks passed. Output: ${join(workdir, "viz")}` : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
