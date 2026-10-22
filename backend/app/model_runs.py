"""
Past model runs, and getting rid of the ones nothing can reach.

Every Apply writes a whole set of rendered maps — the model, each criterion
and each subcriterion — into `MCDA/runs/<id>/`. Nothing removes them, and
only the newest is ever drawn: `outputs.scan_model` takes `runs[0]` and
nothing in the app asks for another. So a few rounds of tuning leaves most of
a project's disk in folders that cannot be opened from anywhere.

Measured on the project this was written against: three runs, 191 MB each,
against 31 MB of input and 145 MB of pipeline output. Two thirds of the
project was unreachable.

Removing is offered, not done. These are results, and which of them is worth
keeping is not a judgement this app should make quietly — the same reason
`inputs.remove` asks first.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path

from . import outputs, pipeline, store


@dataclass
class Removal:
    """What a clean-up took away."""

    removed: list[str]
    freedBytes: int
    #: Runs that were asked for but are not there. Not an error: two tabs, or
    #: a folder tidied by hand, and the outcome is the one that was wanted.
    missing: list[str]


def _removable(folder: Path) -> bool:
    """Whether this process can delete a folder — which is the parent's business."""
    parent = folder.parent
    return parent.is_dir() and os.access(parent, os.W_OK | os.X_OK)


def prunable(project: store.ProjectRow, keep: int) -> list[str]:
    """
    Which runs a sweep would remove, newest kept.

    `keep` is clamped at 1: the map draws the newest run, and a sweep that
    left a project with no model to look at would be a strange thing to
    offer under the word "clean up".
    """
    runs = outputs.scan_model_runs(project)
    return runs[max(1, keep):]


def remove(project: store.ProjectRow, run_ids: list[str]) -> Removal:
    """
    Delete these runs, together.

    Together because the container route costs a few seconds to start, so
    removing six runs one call at a time would spend most of its time
    starting containers.

    The ids are resolved against what is on disk before anything is run —
    `outputs.model_run_path` only returns folders it has just listed — so a
    made-up id cannot reach the shell inside the container.
    """
    paths: list[tuple[str, Path]] = []
    missing: list[str] = []
    for run_id in run_ids:
        path = outputs.model_run_path(project, run_id)
        if path is None or not path.is_dir():
            missing.append(run_id)
        else:
            paths.append((run_id, path))

    if not paths:
        return Removal(removed=[], freedBytes=0, missing=missing)

    # Measured before, because afterwards there is nothing to measure.
    freed = sum(outputs.folder_size(path)[0] for _, path in paths)

    by_hand = all(_removable(path) for _, path in paths)
    if by_hand:
        for _, path in paths:
            shutil.rmtree(path, ignore_errors=True)
    else:
        # The engine runs as root, so everything it wrote belongs to root and
        # the server cannot unlink it however much it owns the folder above.
        # Chowning is not a fix either: the next run writes root-owned files
        # again.
        if not pipeline.can_remove_as_root():
            raise ValueError(
                "These runs belong to root, because the engine wrote them, and Docker "
                "is not available to remove them. Start Docker, or delete "
                f"{paths[0][1].parent} by hand."
            )
        data_dir = outputs.data_dir(project)
        if data_dir is None:
            raise ValueError("This project has no folder to remove anything from.")
        relatives = [
            str(path.relative_to(data_dir)).replace(os.sep, "/") for _, path in paths
        ]
        problem = pipeline.remove_many_as_root(data_dir, relatives)
        if problem:
            raise ValueError(f"Could not remove the model runs: {problem}")

    still_there = [run_id for run_id, path in paths if path.exists()]
    if still_there:
        raise ValueError(
            f"Asked to remove {len(paths)} runs, but {len(still_there)} are still there: "
            + ", ".join(still_there)
        )

    return Removal(
        removed=[run_id for run_id, _ in paths],
        freedBytes=freed,
        missing=missing,
    )
