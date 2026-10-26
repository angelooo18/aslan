# Third-party notices

ASLAN vendors two MIT-licensed pi packages and includes the user-authored Mermaid
extension. The vendored source keeps its original license files.

## pi-interactive-subagents

- Source: https://github.com/amosblomqvist/pi-interactive-subagents
- Author: Amos Blomqvist
- License: MIT (see `vendor/pi-interactive-subagents/LICENSE`)
- Location: `vendor/pi-interactive-subagents`

## pi-observational-memory

- Source: https://github.com/amosblomqvist/pi-observational-memory
- Author: Amos Blomqvist
- License: MIT (see `vendor/pi-observational-memory/LICENSE`)
- Location: `vendor/pi-observational-memory`

## Mermaid extension

- Source: https://github.com/angelooo18/mermaid
- License: MIT, as part of ASLAN
- Location: `vendor/mermaid`

## External npm dependencies

ASLAN declares its external runtime dependencies in `package.json`; they are installed by
npm and keep their own licenses. These include `playwright` (Apache-2.0),
`@mermaid-js/mermaid-cli` (MIT), `puppeteer` (Apache-2.0), and `sharp` (Apache-2.0).
Browser binaries downloaded by the setup script are not distributed in this repository.

## ASLAN code

The local extensions under `extensions/`, the agents under `agents/`, the scripts, and the
configuration examples are part of ASLAN and MIT licensed under the root `LICENSE`.
