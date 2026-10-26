# mermaid

A [pi](https://pi.dev) extension that draws diagrams. One tool, no subagents, no session state:

```
render_mermaid({ source, format?, save_as? })  →  image inline
```

Ask for a diagram, get a picture back in the conversation. If you want it kept, it saves to `viz/`.

## Install

```bash
pi install git:github.com/angelooo18/mermaid
```

Or try it for a single run:

```bash
pi -e git:github.com/angelooo18/mermaid
```

Then just ask: *"draw the auth flow as a mermaid diagram"*.

## The tool

| Parameter | Default | Meaning |
|---|---|---|
| `source` | — | Full Mermaid text, starting with the diagram type (`graph TD`, `sequenceDiagram`, `erDiagram`, …) |
| `file` | — | Path to a `.mmd` file to render instead of `source` — cheaper when iterating: edit the file, call again |
| `format` | `png` | `png`, `svg`, or `jpg` |
| `theme` | mermaid's default | `default`, `neutral`, `dark`, `forest`, `base` |
| `background` | `white` | Any CSS color; `transparent` works for png/svg (jpg has no alpha) |
| `scale` | `2` | Pixel density for png/jpg, 1–4 |
| `save_as` | — | Kebab-case slug → saves `viz/mermaid-<slug>-<timestamp>.<format>` |

Without `save_as` it's a preview: nothing touches your project. Every render returns the image inline, so the model can see what it drew — SVG and JPG included (SVG comes back as a browser-rendered PNG preview).

### Formats

| format | produced by | notes |
|---|---|---|
| `png` | mermaid-cli | 2× scale by default; raster for chat/screenshots |
| `svg` | mermaid-cli | true vector output, sharp at any zoom — best for docs, slides, READMEs |
| `jpg` | PNG → [sharp](https://sharp.pixelplumbing.com) | smaller, quality 92, flattened onto `background` |

## Requirements

- Node ≥ 20
- A browser for mermaid-cli. It needs none installed: `puppeteer` is a dependency and downloads its own Chrome on install. To use a system browser instead, set `PI_MERMAID_CHROME=/usr/bin/chromium` (also honours `CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH`).

| Env var | Default | Meaning |
|---|---|---|
| `PI_MERMAID_DIR` | `viz` | Where saved diagrams go, relative to the project root |
| `PI_MERMAID_CHROME` | auto | Browser binary to drive |

## Verify it

```bash
npm install && npm run smoke
```

17 checks, no model involved: every format writes a real PNG/SVG/JPEG, previews stay out of the project, bad syntax reports an error instead of a diagram, bad arguments are rejected.

## Credit

Originally extracted from [amosblomqvist/learn](https://github.com/amosblomqvist/learn)'s `visual-tools` extension, then reduced to its essentials. The earlier three-tool version (managed source file, `write`/`edit`/`render`, subagent support) is preserved at tag [`v0.2.0-loop`](https://github.com/angelooo18/mermaid/tree/v0.2.0-loop).
