# AutoMD — Zotero PDF to Markdown Converter

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square)](LICENSE)
[![CI](https://github.com/WeiCheng14159/zotero-md/actions/workflows/ci.yml/badge.svg)](https://github.com/WeiCheng14159/zotero-md/actions/workflows/ci.yml)
[![Release](https://github.com/WeiCheng14159/zotero-md/actions/workflows/release.yml/badge.svg)](https://github.com/WeiCheng14159/zotero-md/releases)

AutoMD is a [Zotero 7](https://www.zotero.org) plugin that automatically converts PDF attachments into Markdown files using Python. It is designed for LLM workflows, note-taking pipelines (Obsidian, Logseq, etc.), and any use case where you need machine-readable text from your research papers.

## Features

- **Auto-convert on download** — When a new PDF is added to Zotero, AutoMD immediately converts it to Markdown in the background (can be disabled in preferences).
- **Right-click "Convert to Markdown"** — Convert selected items' PDFs on demand via the context menu.
- **Bulk conversion** — Tools → "AutoMD: Convert All PDFs" scans your entire library and converts any PDFs that don't yet have a Markdown sibling.
- **Two conversion engines**:
  - [`docling`](https://github.com/DS4SD/docling) (default) — High-quality, structure-aware conversion.
  - [`pymupdf4llm`](https://pymupdf.readthedocs.io/en/latest/pymupdf4llm/) — Fast, lightweight conversion.
- **Auto-attaches result** — The generated `.md` file is imported back into Zotero as a `text/markdown` attachment on the same parent item.
- **Auto-detects Python** — Scans `~/.virtualenvs`, Homebrew, and system paths for `python3`. Manual override available in preferences.
- **Configurable output directory** — Place Markdown files next to the PDF (default) or in a custom folder.

## Requirements

- Zotero 7
- Python 3 with at least one of the following installed:
  ```sh
  pip install docling        # default engine
  pip install pymupdf4llm    # alternative engine
  ```

## Installation

1. Download the latest `.xpi` from the [Releases page](https://github.com/WeiCheng14159/zotero-md/releases).
2. In Zotero: **Tools → Add-ons → gear icon → Install Add-on From File…**
3. Select the downloaded `.xpi` and restart Zotero.

## Configuration

Open **Edit → Preferences → AutoMD** (or **Zotero → Settings → AutoMD** on macOS):

| Setting | Default | Description |
|---|---|---|
| Auto-convert on download | On | Automatically convert new PDFs when added |
| Converter engine | `docling` | Choose between `docling` and `pymupdf4llm` |
| Python path | *(auto-detected)* | Override the Python 3 binary path |
| Output directory | *(next to PDF)* | Custom directory for `.md` output files |
| Attach result to Zotero | On | Import the `.md` file as a Zotero attachment |

## How It Works

1. On startup, AutoMD auto-detects `python3` and verifies the selected engine is importable.
2. A `Zotero.Notifier` observer watches for new `item` events. When a PDF attachment is added and auto-convert is enabled, conversion runs in the background.
3. The plugin polls up to 30 seconds for the file to appear on disk (handles in-progress downloads).
4. Conversion runs via a Python subprocess (`/bin/sh -c "python3 -c '...'"`) using the selected engine.
5. On success, the `.md` file is optionally imported back into Zotero as a stored `text/markdown` attachment.

## Development

### Setup

```sh
git clone https://github.com/WeiCheng14159/zotero-md.git
cd zotero-md
npm install
cp .env.example .env
# Edit .env to point to your Zotero beta binary
```

### Commands

| Command | Description |
|---|---|
| `npm start` | Start dev server with hot-reload |
| `npm run build` | Build plugin (output in `.scaffold/build/`) |
| `npm run lint:check` | Check formatting and linting |
| `npm run lint:fix` | Auto-fix formatting and linting |
| `npm run test` | Run integration tests |

### Project Structure

```
.
├── .github/workflows/    # CI (lint, build, test) and Release workflows
├── addon/
│   ├── bootstrap.js      # Zotero bootstrap entry point
│   ├── content/
│   │   ├── icons/        # Plugin icons
│   │   └── preferences.xhtml  # Preferences UI
│   ├── locale/
│   │   ├── en-US/        # English strings (.ftl)
│   │   └── zh-CN/        # Chinese strings (.ftl)
│   ├── manifest.json     # Firefox/Zotero manifest
│   └── prefs.js          # Default preference values
└── src/
    ├── index.ts           # Plugin entry point
    ├── addon.ts           # Addon class and runtime state
    ├── hooks.ts           # Lifecycle hooks, notifier, menu handlers
    └── modules/
        └── converter.ts   # Python detection, engine verification, conversion logic
```

## CI/CD

This project uses GitHub Actions for automated quality checks and releases.

### Continuous Integration (`ci.yml`)

Runs on every push and pull request to `main`:

- **lint** — Prettier + ESLint checks
- **build** — TypeScript compilation + XPI bundling
- **test** — Integration tests (depends on build)

### Release (`release.yml`)

Triggered automatically when a version tag (`v*`) is pushed:

```sh
# Bump version, tag, and push — CI will build and release
npm run release
```

The release workflow builds the plugin, packages the `.xpi`, and publishes it to GitHub Releases. It also generates `update.json` (stable) or `update-beta.json` (pre-release, versions containing `-`) so Zotero can deliver automatic updates.

### Dependabot

Weekly automated dependency updates with minor and patch bumps grouped into a single PR.

## License

[AGPL-3.0-or-later](LICENSE)
