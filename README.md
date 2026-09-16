# Hermes Desktop Plugins

A collection of custom plugins for [Hermes Agent](https://hermes-agent.nousresearch.com/) Desktop. Each plugin adds a side panel (and sometimes a statusbar chip) to the Hermes desktop app.

---

## Plugins

### 1. Obsidian Vault Search

Search your Obsidian vault directly from Hermes Desktop. Find notes by filename or full-text content, preview them in the side panel, copy paths, and open files in Obsidian.

**Features**

- **Three search modes** — search by filenames only, note content only, or both at once
- **Content match context** — shows the matching line and line number for content hits
- **File preview** — click any result to view the full note content in the side panel
- **Copy paths** — one-click copy of either the full filesystem path or the vault-relative path
- **Configurable vault path** — settings dialog with path validation (checks for `.obsidian` folder)
- **Vault structure tree** — get a text representation of your vault's folder hierarchy
- **Open in Obsidian** — generates `obsidian://` URIs to open notes directly in the Obsidian app
- **Security** — path traversal protection; files outside the vault cannot be read

**Architecture**

```
Obsidian-Search-Plugin/
├── desktop-plugins/obsidian-vault-search/
│   └── plugin.js              # React UI (side panel, settings dialog)
└── plugins/obsidian-vault-search/dashboard/
    ├── manifest.json          # Plugin metadata
    └── plugin_api.py          # FastAPI backend — search, read, vault info
```

The frontend calls the backend via Hermes plugin SDK's `ctx.rest()`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/search` | POST | Search filenames and/or content |
| `/structure` | GET | Get vault folder tree |
| `/read` | GET/POST | Read a file's content |
| `/info` | GET/POST | Vault metadata (note count, folders, recent notes) |
| `/open` | POST | Generate obsidian:// URI for a file |

**Configuration**

Click the gear icon in the side panel header to open settings. Enter your vault path (must contain a `.obsidian` folder). The path is validated before saving and persisted per-profile.

Default path: `C:\Users\paulm\OneDrive\AI\KnowledgeBase` (override via `OBSIDIAN_VAULT_PATH` env var).

---

### 2. System Resources Monitor

Real-time system resource monitoring with a tabbed side panel and a compact statusbar chip showing live CPU, RAM, GPU, and VRAM usage.

**Features**

- **CPU monitoring** — total usage, per-core breakdown with individual sparklines
- **Memory monitoring** — system RAM and swap usage with progress bars
- **GPU monitoring** — utilization, VRAM, temperature, and power draw (NVIDIA only)
- **Live sparkline charts** — 60-point rolling history (2 min at 2s intervals) rendered as SVG
- **Color-coded usage** — green → yellow → red as usage increases
- **Statusbar chip** — compact always-visible summary in Hermes statusbar
- **Four tabs** — Overview (2×2 grid), CPU (cores), Memory (RAM + swap), GPU (details)
- **Manual refresh** — pull-to-refresh button for on-demand updates

**Architecture**

```
Resources-Plugin/
├── desktop-plugins/system-resources/
│   └── plugin.js              # React UI (side panel + statusbar chip)
└── plugins/system-resources/dashboard/
    ├── manifest.json          # Plugin metadata
    └── plugin_api.py          # FastAPI backend — psutil + pynvml/nvidia-smi
```

The frontend polls the backend every 2 seconds; the statusbar chip polls every 3 seconds:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/resources` | GET | All system data (CPU + memory + GPU) |
| `/cpu` | GET | CPU data (total, cores, history) |
| `/memory` | GET | RAM and swap data |
| `/gpu` | GPU data (utilization, VRAM, temp, power) |
| `/summary` | GET | Quick summary for statusbar chip |
| `/health` | GET | Dependency availability check |

**GPU Detection**

The backend tries GPU detection in this order:

1. **pynvml** (preferred) — Python bindings for NVML, faster and more reliable
2. **nvidia-smi** fallback — shells out to the CLI tool if pynvml isn't installed

Without either, the GPU tab shows "No GPU detected or access denied."

---

## Installation

Each plugin lives in its own subdirectory under the repo root. To use a plugin, place its two directories (`desktop-plugins/<id>/` and `plugins/<id>/dashboard/`) into your Hermes plugins directory so that both the frontend (`.js`) and backend (`manifest.json` + `plugin_api.py`) are discoverable by the Hermes Desktop app.

The exact location depends on your Hermes installation — typically:

- **Desktop plugins:** alongside Hermes's built-in desktop extensions
- **Dashboard plugins:** alongside Hermes's built-in dashboard APIs

Restart Hermes Desktop after adding a plugin. Both plugins are enabled by default (`defaultEnabled: true`).

## Dependencies

The following Python packages are required and must be available to Hermes's Python environment:

- `psutil` — CPU and memory monitoring (Resources Plugin)
- `pynvml` — NVIDIA GPU monitoring, optional but recommended (Resources Plugin)

Install them into Hermes's Python environment:

```bash
pip install psutil pynvml
```

## Development

Both plugins are built with:

- **Frontend:** React + `@hermes/plugin-sdk` — uses SDK components (`Button`, `Input`, `Select`, `Badge`, `Codicon`, etc.) and CSS custom properties for theming
- **Backend:** FastAPI routers mounted under `/api/plugins/<plugin-id>/`

Each plugin is self-contained in its own directory and can be developed, tested, and enabled independently.

## License

MIT
