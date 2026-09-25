"""
Looking at folders on the machine running this server.

The browser deliberately cannot read an absolute path out of a file picker, so
every path the UI sends is text the user typed or pasted. That makes this
module the only thing standing between a typo and a confusing empty folder
list — it is where paths get checked, not the UI.
"""

from __future__ import annotations

import os
from pathlib import Path

from .models import InspectResult, PickFolderResult

#: Stop walking a folder after this many files. A data folder can hold
#: hundreds of thousands; the UI only wants a rough size, and an exact count
#: is not worth making the request hang.
MAX_WALK_FILES = 20_000


def expand(raw: str) -> Path:
    """`~/data` and `$HOME/data` are what people actually type."""
    return Path(os.path.expandvars(os.path.expanduser(raw.strip()))).resolve()


def measure(path: Path) -> tuple[int, int]:
    """(file count, total bytes), capped so a huge tree cannot stall us."""
    files = 0
    total = 0
    for root, _dirs, names in os.walk(path):
        for name in names:
            try:
                total += (Path(root) / name).stat().st_size
            except OSError:
                # A broken symlink or an unreadable file should not fail the
                # whole measurement.
                continue
            files += 1
            if files >= MAX_WALK_FILES:
                return files, total
    return files, total


def inspect(raw: str) -> InspectResult:
    """Check one path and describe what is wrong with it, if anything."""
    if not raw.strip():
        return InspectResult(
            path=raw, exists=False, isDirectory=False, problem="Enter a folder path"
        )

    path = expand(raw)

    if not path.exists():
        return InspectResult(
            path=str(path), exists=False, isDirectory=False, problem="No such folder"
        )
    if not path.is_dir():
        return InspectResult(
            path=str(path), exists=True, isDirectory=False, problem="That is a file, not a folder"
        )
    if not os.access(path, os.R_OK):
        return InspectResult(
            path=str(path), exists=True, isDirectory=True, problem="That folder is not readable"
        )

    files, size = measure(path)
    return InspectResult(
        path=str(path), exists=True, isDirectory=True, fileCount=files, sizeBytes=size
    )


def folder_exists(raw: str) -> bool:
    try:
        return expand(raw).is_dir()
    except OSError:
        return False


def pick_folder() -> PickFolderResult:
    """
    Open a native directory chooser on this machine, if one exists.

    Often there is not one — a headless box, or WSL without the Tk bindings
    installed — so this reports why rather than failing silently, and the UI
    keeps its "paste a path" field as the way that always works.
    """
    try:
        import tkinter  # noqa: PLC0415 — optional, and importing costs nothing when unused
        from tkinter import filedialog  # noqa: PLC0415
    except Exception:
        return PickFolderResult(
            unavailable="No native folder dialog on this machine — paste the path instead."
        )

    try:
        root = tkinter.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        chosen = filedialog.askdirectory(title="Choose a data folder")
        root.destroy()
    except Exception as error:  # a missing display lands here
        return PickFolderResult(unavailable=f"Could not open a folder dialog ({error}).")

    return PickFolderResult(path=chosen or None)
