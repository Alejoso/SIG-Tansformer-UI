"""
Shared setup for the backend's tests.

The modules read their folders when they are imported (`store.DATA_DIR`,
`pipeline.PIPELINE_DIR`), so the environment is pointed somewhere harmless
here, before any of them is: a fresh data folder, and an "engine" that is
only a folder, so nothing in a test can reach the real engine, its `.env` or
Docker. Each test then gets its own data folder through `data_dir`.

Run from `backend/`:

    .venv/bin/pip install -r requirements-dev.txt
    .venv/bin/python -m pytest
"""

from __future__ import annotations

import atexit
import os
import shutil
import sys
import tempfile
from pathlib import Path

_SCRATCH = Path(tempfile.mkdtemp(prefix="maphex-tests-"))
# Only ever the folder `mkdtemp` just made.
atexit.register(shutil.rmtree, _SCRATCH, ignore_errors=True)
os.environ["MAPHEX_DATA_DIR"] = str(_SCRATCH / "data")
os.environ["MAPHEX_PIPELINE_DIR"] = str(_SCRATCH / "engine")
(_SCRATCH / "engine").mkdir(parents=True, exist_ok=True)

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from app import countries, meshes, store, variable_settings  # noqa: E402


@pytest.fixture
def data_dir(tmp_path, monkeypatch) -> Path:
    """A data folder of the test's own, for the CSVs and the uploads."""
    folder = tmp_path / "data"
    folder.mkdir()
    monkeypatch.setattr(store, "DATA_DIR", folder)
    monkeypatch.setattr(store, "PROJECTS_CSV", folder / "projects.csv")
    monkeypatch.setattr(store, "FOLDERS_CSV", folder / "folders.csv")
    monkeypatch.setattr(store, "RUNS_CSV", folder / "runs.csv")
    monkeypatch.setattr(variable_settings, "SETTINGS_CSV", folder / "variable_settings.csv")
    return folder


@pytest.fixture
def engine_countries(tmp_path, monkeypatch) -> Path:
    """
    A small stand-in for the engine's Natural Earth 10m file: the same
    columns, three countries, one of them without an ISO code (as France and
    Norway are in the real one).
    """
    import geopandas as gpd
    from shapely.geometry import box

    engine = tmp_path / "engine"
    path = engine / countries.ENGINE_COUNTRIES
    path.parent.mkdir(parents=True)
    gpd.GeoDataFrame(
        {
            "code": ["URY", "FRA", "COL"],
            "iso_a3": ["URY", None, "COL"],
            "name": ["Uruguay", "France", "Colombia"],
            "name_long": ["Oriental Republic of Uruguay", "France", "Colombia"],
            "continent": ["South America", "Europe", "South America"],
        },
        geometry=[box(-58, -35, -53, -30), box(-5, 42, 8, 51), box(-79, -4, -67, 12)],
        crs="EPSG:4326",
    ).to_parquet(path)
    monkeypatch.setattr(countries.pipeline, "PIPELINE_DIR", engine)
    countries.reset_cache()
    yield path
    countries.reset_cache()


@pytest.fixture
def no_engine_countries(tmp_path, monkeypatch):
    """An engine checkout without the 10m file: the 110m names are the fallback."""
    monkeypatch.setattr(countries.pipeline, "PIPELINE_DIR", tmp_path / "old-engine")
    countries.reset_cache()
    yield
    countries.reset_cache()


@pytest.fixture
def small_uploads(monkeypatch):
    """A one-kilobyte upload limit, to test the limit without a large file."""
    monkeypatch.setattr(meshes, "MAX_UPLOAD_BYTES", 1024)
