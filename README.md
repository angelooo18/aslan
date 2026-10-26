# ASLAN

**ASLAN** is a self-contained [pi](https://pi.dev) agent stack. One package brings the
subagent tree, the agent roster, browser debugging, DeepSeek web search/fetch, the
permission gate, subagent limits, Mermaid rendering, and observational memory.

The intended install is a single pi package. It does not need the separate
`pi-interactive-subagents`, `mermaid`, or `pi-observational-memory` packages: their
source is vendored here and loaded together.

## Requirements

- [pi.dev](https://pi.dev) 1.4 or newer (Node.js comes with pi)
- `tmux` for interactive subagents
- A DeepSeek account/API key (`/login` inside pi, or `DEEPSEEK_API_KEY`)
- `git` for the git install; `npm`/`npx` for dependencies

The setup script downloads the browser engines used by Playwright and Mermaid. No
separate Chrome install is required.

## Install

```bash
pi install git:github.com/angelooo18/aslan@v1.0.0
cd ~/.pi/agent/git/github.com/angelooo18/aslan
./scripts/setup.sh
```

Or clone it yourself:

```bash
git clone https://github.com/angelooo18/aslan ~/ASLAN
cd ~/ASLAN
npm install --omit=dev
pi install ./
./scripts/setup.sh
```

After setup:

1. Run `pi`
2. Log in to DeepSeek with `/login`, or export `DEEPSEEK_API_KEY`
3. Run `/reload`
4. Try `/subagent scout "map this repository"` and `/om on`

ASLAN replaces the standalone `mermaid`, `pi-interactive-subagents`, and
`pi-observational-memory` packages. If you already have them installed, remove their
entries from `~/.pi/agent/settings.json` so commands and tools are not registered twice.

## What setup does

- Installs production npm dependencies if the package was cloned.
- Downloads Playwright Chromium and the Puppeteer Chrome used by Mermaid.
- Copies `AGENTS.md`, `permissions.json`, and `subagent-limits.json` into
  `~/.pi/agent/` **only if they do not already exist**.
- Merges DeepSeek defaults into `~/.pi/agent/settings.json` **without overwriting
  existing keys** (a timestamped backup is written first).
- Leaves `auth.json`, sessions, and other private runtime state untouched.

## Agent roster

| Agent | Role | Model |
|---|---|---|
| `scout` | Read-only codebase recon | `deepseek/deepseek-flash` |
| `researcher` | Web research with DeepSeek search/fetch | `deepseek/deepseek-flash` |
| `vision` | Screenshots, diagrams, OCR, visual diff | `deepseek/deepseek-flash` |
| `browser` | Playwright browser debugging/audit | `deepseek/deepseek-flash` |
| `worker` | Implementation, can delegate to scout/researcher/browser | `deepseek/deepseek-flash` |
| `verifier` | Independent read-only PASS/FAIL verification | `deepseek/deepseek-flash` |

The definitions live in `agents/`. The vendored subagents extension loads them from this
package; a `~/.pi/agent/agents/*.md` file with the same name overrides a bundled agent.

## What is included

| Area | Entry point | Commands/tools |
|---|---|---|
| Subagents | `vendor/pi-interactive-subagents` | `subagent`, `subagent_message`, `subagents_list`, `/subagent` |
| Limits | `extensions/subagent-limits.ts` | `subagent_limits`; 6 live / 3 per turn / depth 2 |
| Permissions | `extensions/permissions.ts` | `permissions_status`; headless deny + audit |
| DeepSeek web | `extensions/deepseek-search.ts` | `deepseek_search`, `deepseek_fetch` |
| Browser | `extensions/browser/index.ts` | `browser_goto`, `browser_eval`, `browser_console`, `browser_network`, `browser_fill`, `browser_click`, `browser_screenshot`, `browser_close`; `/browser on` |
| Mermaid | `vendor/mermaid` | `render_mermaid` |
| Observational memory | `vendor/pi-observational-memory` | `/om`, `/om:status`, `/om:compact`, `/om:consolidate` |

Browser tools and observational memory are opt-in per session. The browser agent enables
its tools automatically; in the main session use `/browser on`. Observational memory is
enabled with `/om on`.

## Policy and configuration

`AGENTS.md` contains the working agreement: plan before non-trivial work, verify each
coherent unit with the `verifier` agent, and ask before consequential actions. It is
copied to `~/.pi/agent/AGENTS.md` only if you do not already have one.

The runtime configuration lives in `~/.pi/agent/`:

- `permissions.json` — permission gate policy and allowlist
- `subagent-limits.json` — concurrency, per-turn spawns, depth
- `settings.json` — DeepSeek defaults and the `observational-memory` block

The example defaults are in `config/`. Keep secrets out of this repository: use
`/login` or the `DEEPSEEK_API_KEY` environment variable.

## Repository hygiene

This repository deliberately contains no credentials, chat sessions, browser profiles,
audit logs, or machine paths. Node modules and downloaded browser binaries are not
committed; the package manager and `scripts/setup.sh` recreate them.

## License and attribution

ASLAN is MIT licensed. The vendored subagent and observational-memory packages are MIT
licensed by Amos Blomqvist; see `THIRD_PARTY_NOTICES.md` and the vendored `LICENSE` files.
Mermaid and the local extensions are part of ASLAN. External npm dependencies keep their
own licenses.

## Agradecimientos y referencias / Acknowledgements and references

Gracias a los autores y mantenedores de estos proyectos, que hacen posible ASLAN:

- [pi-observational-memory (angelooo18)](https://github.com/angelooo18/pi-observational-memory) — fork de ASLAN con el fix de consolidación.
- [pi-interactive-subagents (amosblomqvist)](https://github.com/amosblomqvist/pi-interactive-subagents) — runtime de subagentes vendorizado.
- [pi-observational-memory (amosblomqvist)](https://github.com/amosblomqvist/pi-observational-memory) — proyecto original de Observational Memory.

Thank you to the authors and maintainers of these projects.
