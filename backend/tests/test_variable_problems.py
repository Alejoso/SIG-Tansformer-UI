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


def test_a_variable_left_to_the_corrections_step_says_so(tmp_path):
    """The ingest and the H3 conversion leave five variables to the engine's step 10.5 and
    say so in the variable's log. When that step then did not build it (the run stopped
    before, or an engine that could not find its source), the panel said "stopped partway,
    with nothing saying why"; now it says which step was to build it."""
    for stage, motivo in (("INGESTA", "lo construye la etapa 10.5 (apply_variable_fixes, presencia)"),
                          ("CONVERSION_H3", "la convierte la etapa 10.5 (apply_variable_fixes)")):
        log = _log(tmp_path / f"{stage}.pipeline.jsonl", ("INGESTA", "ok", {}),
                   (stage, "skip", {"motivo": motivo}))
        status, stage_seen, _, _, _ = outputs._problem_from_log(log)
        assert (status, stage_seen) == ("notBuilt", "CORRECCIONES")
    # and when the step failed, its own error wins
    log = _log(tmp_path / "failed.pipeline.jsonl",
               ("INGESTA", "skip", {"motivo": "lo construye la etapa 10.5 (apply_variable_fixes, columna x)"}),
               ("CORRECCIONES", "error", {"error": "la litologia del paso 10.5 necesita la columna 'clasificac'"}))
    status, stage_seen, reason, _, _ = outputs._problem_from_log(log)
    assert (status, stage_seen) == ("error", "CORRECCIONES") and "clasificac" in reason
