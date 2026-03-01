#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Tuple


CLAUDE_DIR = Path.home() / "Library/Application Support/Claude"
SETTINGS_DIR = CLAUDE_DIR / "Claude Extensions Settings"
INSTALLATIONS_FILE = CLAUDE_DIR / "extensions-installations.json"
CONFIG_FILE = CLAUDE_DIR / "config.json"
DESKTOP_CONFIG_FILE = CLAUDE_DIR / "claude_desktop_config.json"
BACKUP_ROOT = CLAUDE_DIR / "codex-backups"


LEAN_PROFILE_KEEP = {
    "ant.dir.ant.anthropic.filesystem",
    "context7",
}


@dataclass
class ExtensionStats:
    extension_id: str
    enabled: bool
    tools: int
    prompts: int
    command: str


def _load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _save_json(path: Path, value: dict) -> None:
    with path.open("w", encoding="utf-8") as f:
        json.dump(value, f, indent=2, sort_keys=False)
        f.write("\n")


def _settings_files() -> List[Path]:
    if not SETTINGS_DIR.exists():
        return []
    return sorted(SETTINGS_DIR.glob("*.json"))


def _load_installations() -> Dict[str, dict]:
    if not INSTALLATIONS_FILE.exists():
        return {}
    data = _load_json(INSTALLATIONS_FILE)
    return data.get("extensions", {})


def _extension_stats() -> List[ExtensionStats]:
    installations = _load_installations()
    rows: List[ExtensionStats] = []
    for path in _settings_files():
        extension_id = path.stem
        setting = _load_json(path)
        manifest = installations.get(extension_id, {}).get("manifest", {})
        tools = len(manifest.get("tools", []) or [])
        prompts = len(manifest.get("prompts", []) or [])
        command = manifest.get("server", {}).get("mcp_config", {}).get("command", "")
        rows.append(
            ExtensionStats(
                extension_id=extension_id,
                enabled=bool(setting.get("isEnabled")),
                tools=tools,
                prompts=prompts,
                command=command,
            )
        )
    return rows


def audit() -> int:
    rows = _extension_stats()
    enabled = [row for row in rows if row.enabled]
    print("extension_id\tenabled\ttools\tprompts\tcommand")
    for row in rows:
        print(
            f"{row.extension_id}\t{str(row.enabled).lower()}\t"
            f"{row.tools}\t{row.prompts}\t{row.command}"
        )

    print()
    print(f"enabled_extensions={len(enabled)}")
    print(f"enabled_tools={sum(r.tools for r in enabled)}")
    print(f"enabled_prompts={sum(r.prompts for r in enabled)}")
    print("required_commands=" + ",".join(sorted({r.command for r in enabled if r.command})))

    missing = []
    for cmd in sorted({r.command for r in enabled if r.command}):
        if shutil.which(cmd) is None:
            missing.append(cmd)
    if missing:
        print("missing_commands=" + ",".join(missing))
    else:
        print("missing_commands=none")
    return 0


def _backup() -> Path:
    BACKUP_ROOT.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = BACKUP_ROOT / f"backup-{ts}"
    backup_dir.mkdir(parents=True, exist_ok=False)

    if SETTINGS_DIR.exists():
        shutil.copytree(SETTINGS_DIR, backup_dir / "Claude Extensions Settings")
    if CONFIG_FILE.exists():
        shutil.copy2(CONFIG_FILE, backup_dir / "config.json")
    if DESKTOP_CONFIG_FILE.exists():
        shutil.copy2(DESKTOP_CONFIG_FILE, backup_dir / "claude_desktop_config.json")
    return backup_dir


def _apply_extension_profile(enabled_ids: Iterable[str], filesystem_dirs: List[str]) -> None:
    enabled_ids = set(enabled_ids)
    for path in _settings_files():
        data = _load_json(path)
        ext_id = path.stem
        data["isEnabled"] = ext_id in enabled_ids
        if ext_id == "ant.dir.ant.anthropic.filesystem":
            user_cfg = data.setdefault("userConfig", {})
            user_cfg["allowed_directories"] = filesystem_dirs
        _save_json(path, data)


def _set_cool_ui() -> None:
    if not CONFIG_FILE.exists():
        return
    data = _load_json(CONFIG_FILE)
    data["userThemeMode"] = "dark"
    _save_json(CONFIG_FILE, data)


def _disable_extra_desktop_mcp_servers() -> None:
    if not DESKTOP_CONFIG_FILE.exists():
        return
    data = _load_json(DESKTOP_CONFIG_FILE)
    data["mcpServers"] = {}
    preferences = data.setdefault("preferences", {})
    preferences.setdefault("sidebarMode", "code")
    _save_json(DESKTOP_CONFIG_FILE, data)


def _normalize_dirs(raw_dirs: List[str]) -> List[str]:
    dedup: List[str] = []
    seen = set()
    for raw in raw_dirs:
        p = str(Path(raw).expanduser().resolve())
        if p not in seen:
            seen.add(p)
            dedup.append(p)
    return dedup


def apply_lean_profile(workspace: str) -> int:
    if not SETTINGS_DIR.exists():
        print(f"Claude settings directory not found: {SETTINGS_DIR}", file=sys.stderr)
        return 1

    workspace_path = Path(workspace).expanduser().resolve()
    docs_path = (Path.home() / "Documents").resolve()
    filesystem_dirs = _normalize_dirs([str(workspace_path), str(docs_path)])

    before = _extension_stats()
    backup_dir = _backup()
    _apply_extension_profile(LEAN_PROFILE_KEEP, filesystem_dirs)
    _disable_extra_desktop_mcp_servers()
    _set_cool_ui()
    after = _extension_stats()

    before_enabled = [r for r in before if r.enabled]
    after_enabled = [r for r in after if r.enabled]
    print(f"backup={backup_dir}")
    print(
        "enabled_extensions_before="
        f"{len(before_enabled)} after={len(after_enabled)}"
    )
    print(
        "enabled_tools_before="
        f"{sum(r.tools for r in before_enabled)} "
        f"after={sum(r.tools for r in after_enabled)}"
    )
    print(
        "enabled_prompts_before="
        f"{sum(r.prompts for r in before_enabled)} "
        f"after={sum(r.prompts for r in after_enabled)}"
    )
    print("lean_enabled=" + ",".join(sorted(r.extension_id for r in after_enabled)))
    print("filesystem_allowed_directories=" + ",".join(filesystem_dirs))
    return 0


def restore(backup_path: str) -> int:
    backup_dir = Path(backup_path).expanduser().resolve()
    settings_backup = backup_dir / "Claude Extensions Settings"
    config_backup = backup_dir / "config.json"
    desktop_backup = backup_dir / "claude_desktop_config.json"

    if not backup_dir.exists():
        print(f"backup path not found: {backup_dir}", file=sys.stderr)
        return 1

    if settings_backup.exists():
        if SETTINGS_DIR.exists():
            shutil.rmtree(SETTINGS_DIR)
        shutil.copytree(settings_backup, SETTINGS_DIR)
    if config_backup.exists():
        shutil.copy2(config_backup, CONFIG_FILE)
    if desktop_backup.exists():
        shutil.copy2(desktop_backup, DESKTOP_CONFIG_FILE)

    print(f"restored_from={backup_dir}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Audit and tune Claude Desktop extension footprint."
    )
    subparsers = parser.add_subparsers(dest="cmd", required=True)

    subparsers.add_parser("audit", help="Show extension/tool footprint and missing binaries.")

    apply_parser = subparsers.add_parser(
        "apply-lean",
        help="Apply low-overhead profile with backup.",
    )
    apply_parser.add_argument(
        "--workspace",
        default=str(Path.cwd()),
        help="Primary workspace to keep in filesystem extension scope.",
    )

    restore_parser = subparsers.add_parser("restore", help="Restore from backup path.")
    restore_parser.add_argument("--backup", required=True, help="Backup directory path.")

    args = parser.parse_args()

    if args.cmd == "audit":
        return audit()
    if args.cmd == "apply-lean":
        return apply_lean_profile(args.workspace)
    if args.cmd == "restore":
        return restore(args.backup)

    print(f"Unknown command: {args.cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
