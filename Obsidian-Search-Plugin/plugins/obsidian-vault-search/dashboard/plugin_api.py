"""
Obsidian Vault Search Plugin - Python Backend
Handles all filesystem operations for vault search and tree reading.
"""

import os
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Query, Body

router = APIRouter()

# Vault path — update if your vault moves
VAULT_PATH = os.environ.get(
    "OBSIDIAN_VAULT_PATH",
    r"C:\Users\paulm\OneDrive\AI\KnowledgeBase"
)


def _get_vault_path(custom_path: str = None) -> str:
    """Resolve vault path from custom path, env, or fallback."""
    if custom_path:
        return custom_path
    return VAULT_PATH


def _validate_vault(vault_path: str = None) -> tuple[Path | None, str | None]:
    """Validate that the path exists and is an Obsidian vault. Returns (vault_path, error_message)."""
    vault = Path(_get_vault_path(vault_path))
    if not vault.exists():
        return None, "Vault not found at this path"
    obsidian_dir = vault / ".obsidian"
    if not obsidian_dir.is_dir():
        return None, "Not an Obsidian vault — missing .obsidian folder"
    return vault, None


def search_files(query: str, limit: int = 20, vault_path: str = None) -> list[dict[str, Any]]:
    """Search vault by filename (case-insensitive)."""
    vault, error = _validate_vault(vault_path)
    if error:
        return []

    results = []
    query_lower = query.lower()
    for md_file in vault.rglob("*.md"):
        if query_lower in md_file.name.lower():
            rel = str(md_file.relative_to(vault))
            results.append({
                "path": str(md_file),
                "name": md_file.name,
                "folder": rel.split("/")[0] if "/" in rel else "",
                "rel_path": rel,
            })
            if len(results) >= limit:
                break
    return results


def search_content(query: str, limit: int = 20, vault_path: str = None) -> list[dict[str, Any]]:
    """Search vault note contents for a query string."""
    vault, error = _validate_vault(vault_path)
    if error:
        return []

    results = []
    query_lower = query.lower()
    for md_file in vault.rglob("*.md"):
        try:
            text = md_file.read_text(encoding="utf-8", errors="ignore")
            if query_lower in text.lower():
                rel = str(md_file.relative_to(vault))
                # Find the matching line for context
                for i, line in enumerate(text.splitlines()):
                    if query_lower in line.lower():
                        results.append({
                            "path": str(md_file),
                            "name": md_file.name,
                            "folder": rel.split("/")[0] if "/" in rel else "",
                            "rel_path": rel,
                            "context_line": line.strip()[:200],
                            "line_number": i + 1,
                        })
                        break
                if len(results) >= limit:
                    break
        except (OSError, PermissionError):
            continue
    return results


def get_vault_structure(max_depth: int = 3, vault_path: str = None) -> str:
    """Get the vault folder structure as a tree string."""
    vault, error = _validate_vault(vault_path)
    if error:
        return f"{error}: {_get_vault_path(vault_path)}"

    lines = [str(vault)]
    _build_tree(vault, lines, 1, max_depth)
    return "\n".join(lines)


def _build_tree(dirpath: Path, lines: list[str], depth: int, max_depth: int):
    """Recursively build tree representation."""
    if depth > max_depth:
        return

    indent = "    " * depth

    # Get sorted directories and files
    try:
        entries = sorted(dirpath.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except PermissionError:
        return

    dirs = [e for e in entries if e.is_dir() and not e.name.startswith('.')]
    files = [e for e in entries if e.is_file() and e.suffix == '.md']

    # Skip .obsidian and hidden dirs
    dirs = [d for d in dirs if not d.name.startswith('.')]

    for d in dirs:
        lines.append(f"{indent}├── {d.name}/")
        _build_tree(d, lines, depth + 1, max_depth)

    for f in files[:10]:  # Limit files per dir to avoid noise
        lines.append(f"{indent}├── {f.name}")

    if len(entries) > 20:
        remaining = len(entries) - 20
        lines.append(f"{indent}└── ... and {remaining} more")


def open_in_obsidian(file_path: str, vault_path: str = None) -> dict[str, Any]:
    """Attempt to open a file in Obsidian."""
    vault = Path(_get_vault_path(vault_path))
    obsidian_path = Path(file_path)

    # Build the vault-relative path for the obsidian:// URI
    try:
        rel_path = str(obsidian_path.relative_to(vault)).replace("\\", "/")
        obsidian_uri = f"obsidian://open?vault=KnowledgeBase&file={rel_path}"
        return {
            "success": True,
            "uri": obsidian_uri,
            "path": str(obsidian_path),
        }
    except ValueError:
        return {
            "success": False,
            "error": f"File not in vault: {file_path}",
        }


# ─── Plugin API Routes ────────────────────────────────────────────────────────
# These are mounted under /api/plugins/obsidian-vault-search/

@router.post("/search")
async def search_endpoint(
    query: str = Body(..., embed=True),
    limit: int = Body(20, embed=True),
    search_type: str = Body("all", embed=True),  # 'all' | 'files' | 'content'
    vault_path: str = Body(None, embed=True)
) -> dict[str, Any]:
    """Main search endpoint. Returns file matches + content matches based on search_type."""
    results = {"structure": get_vault_structure(vault_path=vault_path)}
    
    if search_type in ("all", "files"):
        results["files"] = search_files(query, limit, vault_path)
    else:
        results["files"] = []
    
    if search_type in ("all", "content"):
        results["content"] = search_content(query, limit, vault_path)
    else:
        results["content"] = []
    
    return results


@router.get("/structure")
async def get_structure(max_depth: int = Query(3), vault_path: str = Query(None)) -> str:
    """Return vault folder structure."""
    return get_vault_structure(max_depth, vault_path)


@router.post("/open")
async def open_file(file_path: str = Body(..., embed=True), vault_path: str = Body(None, embed=True)) -> dict[str, Any]:
    """Open a vault file in Obsidian."""
    return open_in_obsidian(file_path, vault_path)


@router.post("/read")
async def read_file_post(file_path: str = Body(..., embed=True), vault_path: str = Body(None, embed=True)) -> dict[str, Any]:
    """Read a vault file's content (POST)."""
    return await read_file(file_path, vault_path)


@router.get("/read")
async def read_file_get(file_path: str = Query(...), vault_path: str = Query(None)) -> dict[str, Any]:
    """Read a vault file's content (GET)."""
    return await read_file(file_path, vault_path)


async def read_file(file_path: str, vault_path: str = None) -> dict[str, Any]:
    """Read a vault file's content."""
    vault, error = _validate_vault(vault_path)
    if error:
        return {"content": error, "error": error}
    
    file_path = Path(file_path)
    try:
        # Security check: ensure file is within vault
        file_path.resolve().relative_to(vault.resolve())
    except ValueError:
        return {"content": "", "error": "File not in vault"}
    
    if not file_path.exists():
        return {"content": "", "error": "File not found"}
    
    try:
        content = file_path.read_text(encoding="utf-8", errors="ignore")
        return {"content": content}
    except Exception as e:
        return {"content": "", "error": f"Error reading file: {str(e)}"}


def _build_vault_info(vault_path: str | None) -> dict[str, Any]:
    """Build vault metadata payload for the given (or default) path."""
    vault, error = _validate_vault(vault_path)
    if error:
        return {
            "exists": False,
            "path": str(_get_vault_path(vault_path)),
            "reason": "not_an_obsidian_vault" if "missing .obsidian" in error else "not_found",
        }

    md_files = list(vault.rglob("*.md"))
    folders = [d for d in vault.iterdir() if d.is_dir() and not d.name.startswith('.')]

    return {
        "exists": True,
        "path": str(vault),
        "total_notes": len(md_files),
        "folders": sorted([f.name for f in folders]),
        "top_notes": [
            {"name": f.name, "path": str(f)}
            for f in sorted(md_files, key=lambda x: x.stat().st_mtime, reverse=True)[:10]
        ],
    }


@router.get("/info")
async def get_vault_info(vault_path: str = Query(None)) -> dict[str, Any]:
    """Return vault metadata (GET). vault_path comes from the query string."""
    return _build_vault_info(vault_path)


@router.post("/info")
async def get_vault_info_post(vault_path: str = Body(None, embed=True)) -> dict[str, Any]:
    """Return vault metadata (POST). vault_path comes from the request body.

    The desktop plugin SDK's `ctx.rest` does not support query-string params,
    so the settings dialog POSTs the path here for validation.
    """
    return _build_vault_info(vault_path)