"""
What the engine said about a variable it could not finish, as the problems
panel shows it.
"""

from __future__ import annotations

import json
from pathlib import Path

from app import outputs


def _log(path: Path, *entries: tuple[str, str, dict]) -> Path:
    path.write_text("".join(
        json.dumps({"execution_id": f"run_{i}", "stage": stage, "status": status, "details": details}) + "\n"
        for i, (stage, status, details) in enumerate(entries)), encoding="utf-8")
    return path


def test_a_variable_of_another_area_is_a_problem_with_its_reason(tmp_path):
    """The engine draws only the cells inside the mesh; a variable with none says so under
    its own stage, MALLA."""
    log = _log(tmp_path / "x.pipeline.jsonl",
               ("INGESTA", "ok", {}), ("CONVERSION_H3", "ok", {}), ("CARGA_DB", "ok", {}),
               ("MALLA", "error", {"error": "ninguna de sus 63 celdas cae dentro de la malla"}))
    status, stage, reason, _, _ = outputs._problem_from_log(log)
    assert (status, stage) == ("error", "MALLA") and "dentro de la malla" in reason
    assert outputs.STAGE_LABELS["MALLA"] == "checking it against the mesh"


def test_an_error_before_a_later_successful_map_is_history(tmp_path):
    """Fixed since (another mesh, other data): the map was drawn after the error."""
    log = _log(tmp_path / "x.pipeline.jsonl",
               ("MALLA", "error", {"error": "ninguna de sus 63 celdas"}),
               ("CARGA_DB", "ok", {}), ("RENDER_HTML", "ok", {}))
    assert outputs._problem_from_log(log)[0] == "ok"
    # and the other way round it still counts
    log = _log(tmp_path / "y.pipeline.jsonl",
               ("RENDER_HTML", "ok", {}), ("MALLA", "error", {"error": "ninguna"}))
    assert outputs._problem_from_log(log)[0] == "error"
