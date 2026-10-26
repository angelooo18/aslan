/**
 * mermaid — a pi extension for drawing diagrams on demand.
 *
 * One tool, no session state, no subagents:
 *
 *   render_mermaid({ source | file, format?, theme?, background?, scale?, save_as? })
 *
 * It takes Mermaid source (inline, or a path to a .mmd file), renders it with
 * mermaid-cli, and returns the picture inline so you can look at it. With
 * `save_as` it also writes the file to <cwd>/viz and returns the filename.
 *
 * Formats: png (default), svg (native mmdc output), jpg (PNG transcoded with
 * sharp). SVG and JPG still come back as a raster preview inline, because the
 * point is to see what you made.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { spawn } from "node:child_process"
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))

const FORMATS = ["png", "svg", "jpg"] as const
type Format = (typeof FORMATS)[number]

const THEMES = ["default", "neutral", "dark", "forest", "base"] as const

const RENDER_TIMEOUT_MS = 120_000

// pi can be launched with a thin PATH (tmux, GUI, subagent child); augment it so
// a system browser still resolves.
const EXTRA_PATH = [
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/snap/bin",
  "/opt/homebrew/bin",
  "/opt/local/bin",
  join(homedir(), ".local", "bin"),
]

const CHROME_BIN_NAMES = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "brave-browser", "microsoft-edge"]

const CHROME_PATHS = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
]

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function whichSync(name: string): string | undefined {
  for (const dir of [...EXTRA_PATH, ...(process.env.PATH ?? "").split(":")]) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

/** Chrome downloaded by puppeteer (`npx puppeteer browsers install chrome`). */
function findPuppeteerChrome(): string | undefined {
  const roots = [
    process.env.PUPPETEER_CACHE_DIR,
    join(homedir(), ".cache", "puppeteer", "chrome"),
    join(homedir(), "Library", "Caches", "puppeteer", "chrome"),
  ].filter((root): root is string => Boolean(root))
  const rels = [
    join("chrome-linux64", "chrome"),
    join("chrome-linux", "chrome"),
    join("chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
    join("chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
  ]
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const version of readdirSync(root).sort().reverse()) {
      for (const rel of rels) {
        const candidate = join(root, version, rel)
        if (isExecutable(candidate)) return candidate
      }
    }
  }
  return undefined
}

/** A browser for mermaid-cli, or undefined to let puppeteer pick its own. */
function findChrome(): string | undefined {
  for (const fromEnv of [process.env.PI_MERMAID_CHROME, process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH]) {
    const value = fromEnv?.trim()
    if (value && existsSync(value)) return value
  }
  for (const path of CHROME_PATHS) if (isExecutable(path)) return path
  for (const name of CHROME_BIN_NAMES) {
    const found = whichSync(name)
    if (found) return found
  }
  return findPuppeteerChrome()
}

/** `mmdc` from this package's node_modules (walking up), else from PATH. */
function findMmdc(): string | undefined {
  let dir = HERE
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "node_modules", ".bin", "mmdc")
    if (isExecutable(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return whichSync("mmdc")
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function run(cmd: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, PATH: [...EXTRA_PATH, process.env.PATH ?? ""].join(":") },
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, RENDER_TIMEOUT_MS)
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()))
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()))
    child.on("error", (error) => {
      clearTimeout(timer)
      resolveRun({ code: null, stdout, stderr: stderr + String(error), timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolveRun({ code, stdout, stderr, timedOut })
    })
  })
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "diagram"
  )
}

/** Where saved diagrams go, relative to the project root. */
function publishDirName(): string {
  const configured = process.env.PI_MERMAID_DIR?.trim()
  if (!configured) return "viz"
  return configured
}

function publish(renderPath: string, slug: string, format: Format): { filename: string; path: string } {
  const dir = join(process.cwd(), publishDirName())
  mkdirSync(dir, { recursive: true })
  const filename = `mermaid-${slugify(slug)}-${Date.now()}.${format}`
  const path = join(dir, filename)
  copyFileSync(renderPath, path)
  return { filename, path }
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

export default function mermaidExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "render_mermaid",
    label: "Render Mermaid",
    description:
      "Draw a diagram from Mermaid source and return the picture inline. Use it whenever the user asks for a " +
      "diagram, chart of relationships, flow, sequence, state machine, tree, ER/class model, or timeline — and " +
      "look at the returned image before telling the user it is done.\n\n" +
      "Pass `source` (full Mermaid text, e.g. starting with `graph TD`) or `file` (path to a .mmd you wrote — " +
      "cheaper for iterating: edit the file, call again). Formats: `png` (default), `svg` (vector, best for docs " +
      "and slides), `jpg` (compressed, no transparency).\n\n" +
      "Without `save_as` nothing is written to the project — a preview only. With `save_as` (a short kebab-case " +
      "slug) the file is saved to viz/ and the filename is returned so it can be embedded.",
    parameters: Type.Object({
      source: Type.Optional(
        Type.String({
          description: "Complete Mermaid source. Starts with a diagram type, e.g. `graph TD`, `sequenceDiagram`, `erDiagram`.",
        }),
      ),
      file: Type.Optional(
        Type.String({ description: "Path to a .mmd file to render instead of `source` (relative to the project root)." }),
      ),
      format: Type.Optional(
        Type.String({ description: `Output format: ${FORMATS.join(" | ")} (default png).` }),
      ),
      theme: Type.Optional(
        Type.String({ description: `Mermaid theme: ${THEMES.join(" | ")} (default default).` }),
      ),
      background: Type.Optional(
        Type.String({ description: "Background color: 'white' (default), 'transparent' (png/svg only), or a hex color." }),
      ),
      scale: Type.Optional(
        Type.Number({ description: "Pixel density multiplier for png/jpg, 1–4 (default 2). Ignored for svg." }),
      ),
      save_as: Type.Optional(
        Type.String({ description: "Kebab-case slug. When set, the file is saved to viz/ as mermaid-<slug>-<timestamp>.<format>." }),
      ),
    }),
    async execute(_id, params) {
      // ── source ───────────────────────────────────────────────────────────────
      const file = params.file?.trim()
      let source = params.source?.trim() ?? ""
      if (!source && file) {
        const path = resolve(process.cwd(), file)
        if (!existsSync(path)) throw new Error(`render_mermaid: no such file \`${file}\` (resolved to ${path}).`)
        source = readFileSync(path, "utf8").trim()
      }
      if (!source) throw new Error("render_mermaid: pass `source` (Mermaid text) or `file` (path to a .mmd).")

      // ── options ──────────────────────────────────────────────────────────────
      const requested = String(params.format ?? "png").toLowerCase().replace(/^jpeg$/, "jpg")
      if (!FORMATS.includes(requested as Format)) {
        throw new Error(`render_mermaid: unknown format \`${params.format}\` — use ${FORMATS.join(", ")}.`)
      }
      const format = requested as Format
      const background = String(params.background ?? "white")
      const scale = Math.min(4, Math.max(1, Number(params.scale ?? 2) || 2))

      const mmdc = findMmdc()
      if (!mmdc) {
        throw new Error(`render_mermaid: mermaid-cli (mmdc) not found. Run \`npm install\` in ${HERE}.`)
      }

      // ── render ───────────────────────────────────────────────────────────────
      const workDir = mkdtempSync(join(tmpdir(), "pi-mermaid-"))
      const inputPath = join(workDir, "diagram.mmd")
      writeFileSync(inputPath, source, "utf8")

      const chrome = findChrome()
      const puppeteerConfig = join(workDir, "puppeteer.json")
      writeFileSync(
        puppeteerConfig,
        JSON.stringify(
          chrome
            ? { executablePath: chrome, args: ["--no-sandbox", "--disable-dev-shm-usage"] }
            : { args: ["--no-sandbox", "--disable-dev-shm-usage"] },
          null,
          2,
        ),
        "utf8",
      )

      const render = async (outPath: string): Promise<RunResult> => {
        const isSvg = outPath.endsWith(".svg")
        const args = ["-i", inputPath, "-o", outPath, "-p", puppeteerConfig, "-b", background]
        if (!isSvg) args.push("-s", String(scale))
        if (params.theme) args.push("-t", String(params.theme))
        return run(mmdc, args, workDir)
      }

      const fail = (detail: string, note = "") => ({
        isError: true as const,
        content: [
          {
            type: "text" as const,
            text: `${note}Mermaid render failed.\n\n${detail.trim().split("\n").slice(-25).join("\n")}`,
          },
        ],
        details: { ok: false, path: "" },
      })

      // png/svg are native mmdc outputs; jpg is a PNG transcoded with sharp.
      const artifactPath = join(workDir, `diagram.${format === "jpg" ? "png" : format}`)
      const result = await render(artifactPath)
      if (result.code !== 0 || !existsSync(artifactPath)) {
        return fail(result.stderr || result.stdout || "unknown error", result.timedOut ? "mmdc timed out.\n\n" : "")
      }

      // Inline preview: the artifact itself for png; a transcoded jpeg for jpg;
      // a second PNG pass for svg (a browser render, so nothing is approximated).
      let outputPath = artifactPath
      let previewPath = artifactPath
      let previewMime = "image/png"

      try {
        if (format === "jpg") {
          outputPath = join(workDir, "diagram.jpg")
          const sharp = (await import("sharp")).default
          await sharp(artifactPath)
            .flatten({ background: background === "transparent" ? "white" : background })
            .jpeg({ quality: 92 })
            .toFile(outputPath)
          previewPath = outputPath
          previewMime = "image/jpeg"
        } else if (format === "svg") {
          previewPath = join(workDir, "preview.png")
          const preview = await render(previewPath)
          if (preview.code !== 0 || !existsSync(previewPath)) {
            return fail(preview.stderr || preview.stdout || "preview render failed")
          }
        }
      } catch (error) {
        return fail(`converting ${format} failed: ${error instanceof Error ? error.message : String(error)}`)
      }

      const preview = readFileSync(previewPath)
      let dimensions = ""
      try {
        const sharp = (await import("sharp")).default
        const meta = await sharp(previewPath).metadata()
        if (meta.width && meta.height) dimensions = `${meta.width}×${meta.height}`
      } catch {
        // dimensions are cosmetic
      }

      const saved = params.save_as ? publish(outputPath, String(params.save_as), format) : null
      const summary = [
        `Rendered ${format}${dimensions ? ` (${dimensions})` : ""}${saved ? `, ${formatBytes(readFileSync(outputPath).length)}` : ""}.`,
        saved ? `saved: ${saved.path}` : "preview only — pass `save_as` to save it.",
        format === "svg" ? "The file is SVG; the image below is a browser render of it." : "",
      ]
        .filter(Boolean)
        .join("\n")

      return {
        content: [
          { type: "text" as const, text: `${summary}\n\nLook at the diagram: right structure, correct arrows, readable labels?` },
          { type: "image" as const, data: preview.toString("base64"), mimeType: previewMime },
        ],
        details: { ok: true, path: saved?.path ?? outputPath, filename: saved?.filename, format, dimensions },
      }
    },
  })
}
