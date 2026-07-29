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


def _get_vault_path() -> str:
    """Resolve vault path from env or fallback."""
    return VAULT_PATH


def search_files(query: str, limit: int = 20) -> list[dict[str, Any]]:
    """Search vault by filename (case-insensitive)."""
    vault = Path(_get_vault_path())
    if not vault.exists():
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


def search_content(query: str, limit: int = 20) -> list[dict[str, Any]]:
    """Search vault note contents for a query string."""
    vault = Path(_get_vault_path())
    if not vault.exists():
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


def get_vault_structure(max_depth: int = 3) -> str:
    """Get the vault folder structure as a tree string."""
    vault = Path(_get_vault_path())
    if not vault.exists():
        return f"Vault not found at {_get_vault_path()}"

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


def open_in_obsidian(file_path: str) -> dict[str, Any]:
    """Attempt to open a file in Obsidian."""
    vault = Path(_get_vault_path())
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
    search_type: str = Body("all", embed=True)  # 'all' | 'files' | 'content'
) -> dict[str, Any]:
    """Main search endpoint. Returns file matches + content matches based on search_type."""
    results = {"structure": get_vault_structure()}
    
    if search_type in ("all", "files"):
        results["files"] = search_files(query, limit)
    else:
        results["files"] = []
    
    if search_type in ("all", "content"):
        results["content"] = search_content(query, limit)
    else:
        results["content"] = []
    
    return results


@router.get("/structure")
async def get_structure(max_depth: int = Query(3)) -> str:
    """Return vault folder structure."""
    return get_vault_structure(max_depth)


@router.post("/open")
async def open_file(file_path: str = Body(..., embed=True)) -> dict[str, Any]:
    """Open a vault file in Obsidian."""
    return open_in_obsidian(file_path)


@router.post("/read")
async def read_file_post(file_path: str = Body(..., embed=True)) -> dict[str, Any]:
    """Read a vault file's content (POST)."""
    return await read_file(file_path)


@router.get("/read")
async def read_file_get(file_path: str = Query(...)) -> dict[str, Any]:
    """Read a vault file's content (GET)."""
    return await read_file(file_path)


async def read_file(file_path: str) -> dict[str, Any]:
    """Read a vault file's content."""
    vault = Path(_get_vault_path())
    if not vault.exists():
        return {"content": "Vault not found", "error": "Vault not found"}
    
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


@router.get("/info")
async def get_vault_info() -> dict[str, Any]:
    """Return vault metadata."""
    vault = Path(_get_vault_path())
    if not vault.exists():
        return {"exists": False, "path": str(vault)}

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