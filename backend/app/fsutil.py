"""
Looking at folders on the machine running this server.

The browser deliberately cannot read an absolute path out of a file picker, so
every path the UI sends is text the user typed or pasted. That makes this
module the only thing standing between a typo and a confusing empty folder
list — it is where paths get checked, not the UI.
"""

from __future__ import annotations

import os
import shutil
import subprocess
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


#: A dialog left open must not hang the request forever.
PICKER_TIMEOUT_SECONDS = 300


def _is_wsl() -> bool:
    try:
        return "microsoft" in Path("/proc/version").read_text().lower()
    except OSError:
        return False


def _run(command: list[str], **kwargs) -> subprocess.CompletedProcess[str] | None:
    """Run a helper, returning None if it is missing or takes too long."""
    try:
        return subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=PICKER_TIMEOUT_SECONDS,
            check=False,
            **kwargs,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None


def _pick_with_zenity(start: Path) -> PickFolderResult | None:
    if not shutil.which("zenity"):
        return None
    result = _run(
        ["zenity", "--file-selection", "--directory", "--title=Choose a data folder",
         f"--filename={start}/"]
    )
    if result is None:
        return None
    # Exit code 1 is the user cancelling, which is not a failure.
    return PickFolderResult(path=result.stdout.strip() or None)


def _pick_with_kdialog(start: Path) -> PickFolderResult | None:
    if not shutil.which("kdialog"):
        return None
    result = _run(["kdialog", "--getexistingdirectory", str(start)])
    if result is None:
        return None
    return PickFolderResult(path=result.stdout.strip() or None)


def _pick_with_tk(start: Path) -> PickFolderResult | None:
    try:
        import tkinter  # noqa: PLC0415 — optional; importing costs nothing when unused
        from tkinter import filedialog  # noqa: PLC0415
    except Exception:
        return None

    try:
        root = tkinter.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        chosen = filedialog.askdirectory(title="Choose a data folder", initialdir=str(start))
        root.destroy()
    except Exception:
        return None

    return PickFolderResult(path=chosen or None)


#: Opens the standard Windows folder chooser. `-STA` is required for
#: FolderBrowserDialog, and the owner form is what keeps it in front of the
#: browser instead of behind it.
_POWERSHELL_PICKER = """
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose a data folder'
$dialog.ShowNewFolderButton = $false
if ('{start}' -ne '') { $dialog.SelectedPath = '{start}' }
$owner = New-Object System.Windows.Forms.Form -Property @{{ TopMost = $true }}
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {{
  [Console]::Out.Write($dialog.SelectedPath)
}}
$owner.Dispose()
"""


def _pick_with_windows(start: Path) -> PickFolderResult | None:
    r"""
    Use the Windows folder chooser from WSL.

    This machine has no Linux dialog toolkit, but WSL can run Windows
    binaries, and `wslpath` converts what comes back — including a folder
    picked inside WSL, which the dialog reports as a `\\wsl.localhost\...`
    UNC path and which converts to a normal Linux path.
    """
    if not _is_wsl() or not shutil.which("powershell.exe"):
        return None

    # The dialog wants a Windows path to open at; if the start folder has no
    # Windows equivalent, just let it open wherever it likes.
    windows_start = ""
    converted = _run(["wslpath", "-w", str(start)])
    if converted and converted.returncode == 0:
        windows_start = converted.stdout.strip().replace("'", "''")

    script = _POWERSHELL_PICKER.format(start=windows_start)
    # Run from a Windows-visible directory, or PowerShell warns about the cwd.
    result = _run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command", script],
        cwd="/mnt/c",
    )
    if result is None:
        return None

    chosen = result.stdout.strip().strip("\r")
    if not chosen:
        return PickFolderResult(path=None)  # cancelled

    back = _run(["wslpath", "-u", chosen])
    if back is None or back.returncode != 0:
        return PickFolderResult(
            unavailable=f"Could not translate the Windows path {chosen} into a Linux one."
        )
    return PickFolderResult(path=back.stdout.strip())


def pick_folder(start_at: str | None = None) -> PickFolderResult:
    """
    Open a folder chooser on the machine running this server.

    Tries a Linux dialog first, then falls back to the Windows one under WSL.
    Every strategy returns None when it is simply not available, so the chain
    moves on; only an outright failure produces a message. When nothing at all
    can open, the UI still has its paste-a-path field.
    """
    start = Path(start_at).expanduser() if start_at else Path.home()
    if not start.is_dir():
        start = Path.home()

    for strategy in (_pick_with_zenity, _pick_with_kdialog, _pick_with_tk, _pick_with_windows):
        result = strategy(start)
        if result is not None:
            return result

    return PickFolderResult(
        unavailable="No folder dialog on this machine — paste the path instead."
    )
