"""
Meshes: the catalog, the ids, uploads, what the engine is given, the old ids,
and what a mesh without a sea refuses.
"""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi import HTTPException
from starlette.datastructures import UploadFile

from app import main, meshes, model_store, store, variable_settings
from app.models import ModelRunPayload, NewProjectPayload

# ── helpers ───────────────────────────────────────────────────────────────


def _square(x: float = -74.0, y: float = 4.0, size: float = 1.0) -> list:
    return [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]]


def _geojson(features: list[dict]) -> bytes:
    return json.dumps({"type": "FeatureCollection", "features": features}).encode()


def _polygon_feature(name: str, code: str, x: float = -74.0) -> dict:
    return {
        "type": "Feature",
        "properties": {"nombre": name, "codigo": code, "area": 1.5},
        "geometry": {"type": "Polygon", "coordinates": _square(x)},
    }


def _shapefile_zip(tmp_path: Path, *, prj: bool = True, coords: str = "lonlat",
                   folder: str = "zonas/") -> bytes:
    """A real shapefile written by GeoPandas, zipped inside a folder."""
    import geopandas as gpd
    from shapely.geometry import box

    if coords == "lonlat":
        geometry = [box(-74, 4, -73, 5), box(-73, 4, -72, 5)]
    else:
        geometry = [box(1_000_000, 1_000_000, 1_010_000, 1_010_000)]
    frame = gpd.GeoDataFrame(
        {"NAME_1": [f"Zone {i}" for i in range(len(geometry))],
         "COD": [f"Z{i}" for i in range(len(geometry))]},
        geometry=geometry,
        crs="EPSG:4326" if coords == "lonlat" else "EPSG:3116",
    )
    out = tmp_path / "shp"
    out.mkdir(exist_ok=True)
    frame.to_file(out / "Zonas Norte.shp")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        for part in sorted(out.iterdir()):
            if part.suffix == ".prj" and not prj:
                continue
            bundle.write(part, f"{folder}{part.name}")
        bundle.writestr("README.txt", "not a shapefile part")
    return buffer.getvalue()


def _row(**fields) -> store.ProjectRow:
    base = {"id": "p-test", "name": "Test", "mesh_id": "", "mesh_label": ""}
    base.update(fields)
    return store.ProjectRow(**base)


# ── the catalog ───────────────────────────────────────────────────────────


def test_catalog_lists_dane_first_then_natural_earth(engine_countries):
    catalog = meshes.catalog()
    assert catalog[0]["id"] == "dane_colombia"
    assert catalog[0]["recommended"] is True and catalog[0]["hasSea"] is True
    rest = catalog[1:]
    assert [entry["id"] for entry in rest] == [
        "natural_earth:COL", "natural_earth:FRA", "natural_earth:URY",
    ]
    uruguay = next(entry for entry in rest if entry["country"] == "URY")
    # The label is the long name; search finds it by name, code and continent.
    assert uruguay["label"] == "Oriental Republic of Uruguay"
    for term in ("Uruguay", "URY", "South America"):
        assert term in uruguay["search"]
    assert uruguay["geoboundaries"] is True and uruguay["hasSea"] is False


def test_catalog_offers_no_geoboundaries_without_an_iso_code(engine_countries):
    france = next(entry for entry in meshes.catalog() if entry["country"] == "FRA")
    assert france["iso"] == "" and france["geoboundaries"] is False


def test_catalog_falls_back_to_the_110m_names(no_engine_countries):
    catalog = meshes.catalog()
    assert catalog[0]["id"] == "dane_colombia"
    assert len(catalog) > 150
    assert all(entry["id"].startswith("natural_earth:") for entry in catalog[1:])
    assert any(entry["id"] == "natural_earth:URY" for entry in catalog)


def test_list_route_matches_the_catalog(engine_countries):
    listed = main.list_meshes()
    assert listed[0].id == "dane_colombia"
    assert listed[1].source == "natural_earth"


# ── ids ───────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("raw, expected", [
    ("dane_colombia", meshes.MeshSpec(source="dane_colombia")),
    ("natural_earth:ury", meshes.MeshSpec(source="natural_earth", country="URY")),
    ("geoboundaries:URY:adm1",
     meshes.MeshSpec(source="geoboundaries", country="URY", level="ADM1")),
    ("file:u-0123456789ab", meshes.MeshSpec(source="file", upload="u-0123456789ab")),
])
def test_parse_id(raw, expected):
    spec = meshes.parse_id(raw)
    assert spec == expected
    assert meshes.parse_id(spec.id) == spec


@pytest.mark.parametrize("raw", [
    "", "colombia", "natural_earth:", "natural_earth:TOOLONG", "geoboundaries:URY",
    "geoboundaries:URY:ADM3", "geoboundaries:UR:ADM1", "file:../../etc", "file:u-xyz",
    "somewhere:URY",
])
def test_parse_id_refuses_what_is_not_a_mesh(raw):
    with pytest.raises(meshes.MeshError):
        meshes.parse_id(raw)


def test_resolve_checks_what_exists(engine_countries, data_dir):
    assert meshes.resolve("natural_earth:URY").country == "URY"
    assert meshes.resolve("geoboundaries:COL:ADM2").level == "ADM2"
    with pytest.raises(meshes.MeshError):
        meshes.resolve("natural_earth:XYZ")
    # France has no ISO code in Natural Earth, and geoBoundaries is keyed by it.
    with pytest.raises(meshes.MeshError):
        meshes.resolve("geoboundaries:FRA:ADM1")
    with pytest.raises(meshes.MeshError):
        meshes.resolve("file:u-0123456789ab")


# ── uploads ───────────────────────────────────────────────────────────────


def test_upload_geojson(data_dir):
    body = _geojson([_polygon_feature("Norte", "N1"), _polygon_feature("Sur", "S1", -73.0)])
    record = meshes.save_upload("../../Mis Zonas.geojson", io.BytesIO(body))
    folder = meshes.upload_root() / record["id"]
    assert record["file"] == "mis_zonas.geojson"
    assert record["label"] == "Mis Zonas"
    assert record["featureCount"] == 2
    assert set(record["columns"]) == {"nombre", "codigo"}
    assert record["nameField"] == "nombre" and record["codeField"] == "codigo"
    assert (folder / "mis_zonas.geojson").is_file() and (folder / meshes.RECORD_FILE).is_file()
    # Nothing was written where the name tried to point.
    assert not (data_dir.parent / "Mis Zonas.geojson").exists()
    spec = meshes.resolve(f"file:{record['id']}", name_field="nombre")
    assert spec.file == "mis_zonas.geojson" and spec.name_field == "nombre"
    with pytest.raises(meshes.MeshError):
        meshes.resolve(f"file:{record['id']}", name_field="not_a_column")


def test_upload_route_answers_with_a_mesh(data_dir):
    body = _geojson([_polygon_feature("Norte", "N1")])
    mesh = main.upload_mesh(UploadFile(file=io.BytesIO(body), filename="zones.json"))
    assert mesh.id.startswith("file:u-") and mesh.source == "file"
    assert mesh.featureCount == 1 and mesh.hasSea is False


def test_upload_zipped_shapefile(data_dir, tmp_path):
    record = meshes.save_upload("zonas.zip", io.BytesIO(_shapefile_zip(tmp_path)))
    folder = meshes.upload_root() / record["id"]
    assert record["format"] == "Shapefile"
    assert record["file"] == "zonas_norte.shp"
    assert {"zonas_norte.shp", "zonas_norte.shx", "zonas_norte.dbf",
            "zonas_norte.prj"} <= set(record["files"])
    assert record["featureCount"] == 2 and record["nameField"] == "NAME_1"
    # Only the shapefile's parts come out of the zip.
    assert not (folder / "README.txt").exists() and not (folder / "upload.zip").exists()


def test_upload_refuses_a_zip_slip(data_dir, tmp_path):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        bundle.writestr("../../evil.shp", b"x")
        bundle.writestr("../../evil.shx", b"x")
        bundle.writestr("../../evil.dbf", b"x")
    with pytest.raises(meshes.MeshError, match="outside"):
        meshes.save_upload("evil.zip", io.BytesIO(buffer.getvalue()))
    assert not (data_dir.parent / "evil.shp").exists()
    assert not (tmp_path / "evil.shp").exists()
    # The half-made upload is gone too.
    assert list(meshes.upload_root().iterdir()) == []


def test_upload_refuses_points(data_dir):
    point = {"type": "Feature", "properties": {"name": "a"},
             "geometry": {"type": "Point", "coordinates": [-74, 4]}}
    with pytest.raises(meshes.MeshError, match="no polygons"):
        meshes.save_upload("points.geojson", io.BytesIO(_geojson([point])))
    assert list(meshes.upload_root().iterdir()) == []


def test_upload_without_a_crs_in_lonlat_assumes_wgs84(data_dir, tmp_path):
    record = meshes.save_upload("zonas.zip", io.BytesIO(_shapefile_zip(tmp_path, prj=False)))
    assert any("EPSG:4326" in note for note in record["notes"])
    # Written into the kept copy, so the engine reads the same assumption.
    assert (meshes.upload_root() / record["id"] / "zonas_norte.prj").is_file()


def test_upload_without_a_crs_outside_lonlat_is_refused(data_dir, tmp_path):
    body = _shapefile_zip(tmp_path, prj=False, coords="projected")
    with pytest.raises(meshes.MeshError, match="no coordinate system"):
        meshes.save_upload("zonas.zip", io.BytesIO(body))


def test_upload_refuses_other_formats_and_large_files(data_dir, small_uploads):
    with pytest.raises(meshes.MeshError, match="GeoJSON"):
        meshes.save_upload("zones.kml", io.BytesIO(b"<kml/>"))
    big = _geojson([_polygon_feature(f"Zone {i}", f"Z{i}") for i in range(40)])
    with pytest.raises(meshes.MeshError, match="larger"):
        meshes.save_upload("zones.geojson", io.BytesIO(big))
    assert list(meshes.upload_root().iterdir()) == []


def test_upload_route_says_why(data_dir):
    with pytest.raises(HTTPException) as refused:
        main.upload_mesh(UploadFile(file=io.BytesIO(b"not json"), filename="zones.geojson"))
    assert refused.value.status_code == 400


# ── into the project ──────────────────────────────────────────────────────


def test_project_on_an_upload_gets_a_copy(data_dir, tmp_path, engine_countries, monkeypatch):
    monkeypatch.setattr(main.inputs, "scan", lambda row: [])
    record = meshes.save_upload("zonas.zip", io.BytesIO(_shapefile_zip(tmp_path)))
    folder = tmp_path / "project"
    created = main.create_project(NewProjectPayload(
        name="Zones", meshId=f"file:{record['id']}", outFolder=str(folder),
        meshNameField="NAME_1",
    ))
    assert created.meshSource == "file" and created.meshHasSea is False
    # Labelled after the file that was uploaded, the zip here.
    assert created.meshLabel == "zonas (uploaded)"
    for part in ("zonas_norte.shp", "zonas_norte.shx", "zonas_norte.dbf", "zonas_norte.prj"):
        assert (folder / "mesh" / part).is_file()
    row = store.find_project(created.id)
    assert row.mesh_source == "file" and row.mesh_file == "zonas_norte.shp"
    assert meshes.env_for(row)["MESH_PATH"] == "mesh/zonas_norte.shp"


def test_materialise_never_overwrites_a_different_file(data_dir, tmp_path):
    record = meshes.save_upload("zones.geojson",
                                io.BytesIO(_geojson([_polygon_feature("Norte", "N1")])))
    folder = tmp_path / "project"
    (folder / "mesh").mkdir(parents=True)
    (folder / "mesh" / "zones.geojson").write_text("someone else's", encoding="utf-8")
    row = _row(out_folder=str(folder), **meshes.store_fields(
        meshes.resolve(f"file:{record['id']}")))
    assert "already exists" in meshes.materialise(row)
    assert (folder / "mesh" / "zones.geojson").read_text(encoding="utf-8") == "someone else's"


def test_create_project_refuses_an_unknown_mesh(data_dir, engine_countries):
    with pytest.raises(HTTPException) as refused:
        main.create_project(NewProjectPayload(name="X", meshId="natural_earth:XYZ"))
    assert refused.value.status_code == 400


# ── what the engine is given ──────────────────────────────────────────────


EMPTY = dict.fromkeys(meshes.ENV_KEYS, "")


@pytest.mark.parametrize("fields, expected", [
    ({"mesh_id": "dane_colombia", "mesh_source": "dane_colombia"},
     {"MESH_SOURCE": "dane_colombia"}),
    ({"mesh_id": "natural_earth:URY", "mesh_source": "natural_earth", "mesh_country": "URY"},
     {"MESH_SOURCE": "natural_earth", "MESH_COUNTRY": "URY"}),
    ({"mesh_id": "geoboundaries:URY:ADM2", "mesh_source": "geoboundaries",
      "mesh_country": "URY", "mesh_level": "ADM2"},
     {"MESH_SOURCE": "geoboundaries", "MESH_COUNTRY": "URY", "MESH_LEVEL": "ADM2"}),
    ({"mesh_id": "file:u-0123456789ab", "mesh_source": "file", "mesh_file": "zones.gpkg",
      "mesh_name_field": "nombre", "mesh_code_field": "codigo"},
     {"MESH_SOURCE": "file", "MESH_PATH": "mesh/zones.gpkg",
      "MESH_NAME_FIELD": "nombre", "MESH_CODE_FIELD": "codigo"}),
])
def test_mesh_env_for_each_source(data_dir, fields, expected):
    row = _row(**fields)
    assert meshes.env_for(row) == {**EMPTY, **expected}
    # Both runners are handed the same, through the one place runs get it.
    run_env = main._engine_env(row)
    assert {key: run_env[key] for key in meshes.ENV_KEYS} == {**EMPTY, **expected}


# ── projects made before meshes reached the engine ────────────────────────


@pytest.mark.parametrize("old_id, expected", [
    ("colombia", "dane_colombia"),
    ("uruguay", "dane_colombia"),
    ("ireland_5km_mesh.geojson", "dane_colombia"),
    ("", "dane_colombia"),
    ("natural_earth:URY", "natural_earth:URY"),
])
def test_legacy_mesh_ids(engine_countries, old_id, expected):
    assert meshes.legacy_id(old_id) == expected


def test_legacy_colombia_project_runs_as_before(data_dir, engine_countries, monkeypatch):
    monkeypatch.setattr(main.inputs, "scan", lambda row: [])
    monkeypatch.setattr(main.outputs, "has_results", lambda row: False)
    row = _row(mesh_id="colombia", mesh_label="Colombia")
    assert meshes.env_for(row) == {**EMPTY, "MESH_SOURCE": "dane_colombia"}
    project = main._to_project(row)
    assert project.meshId == "dane_colombia" and project.meshHasSea is True
    assert project.meshLabel == "Colombia (DANE)"


# ── what a mesh without a sea refuses ─────────────────────────────────────


def test_sea_fill_is_refused_without_a_sea():
    assert variable_settings.check("spatial", "sea", has_sea=True) == ("spatial", "sea")
    assert variable_settings.check("spatial", "land", has_sea=False) == ("spatial", "land")
    with pytest.raises(variable_settings.SettingsError, match="two projects"):
        variable_settings.check("spatial", "sea", has_sea=False)


def test_sea_fill_is_refused_by_the_routes(data_dir, engine_countries):
    class Item:
        fill = "spatial, median"
        fillDomain = "sea"

    uruguay = _row(mesh_id="natural_earth:URY", mesh_source="natural_earth", mesh_country="URY")
    with pytest.raises(variable_settings.SettingsError):
        main._wanted_settings(Item(), uruguay)
    colombia = _row(mesh_id="dane_colombia", mesh_source="dane_colombia")
    assert main._wanted_settings(Item(), colombia) == ("spatial, median", "sea")


def test_a_stored_sea_fill_stops_the_transform(data_dir, engine_countries, tmp_path):
    class Variable:
        id = "tec/TEC_001"
        code = "TEC_001"
        format = "GEOTIFF"
        note = ""
        problem = ""
        processedOnly = False

    uruguay = _row(mesh_id="natural_earth:URY", mesh_source="natural_earth",
                   mesh_country="URY", out_folder=str(tmp_path / "p"))
    variable_settings.save(uruguay.id, Variable.id, "spatial", "sea", "GEOTIFF")
    with pytest.raises(variable_settings.SettingsError, match="sea"):
        variable_settings.transform_document(uruguay, [Variable()])


OFFSHORE_MODEL = """\
criteria:
  - key: wind
    weight: 1
    subgroups:
      - key: speed
        weight: 1
        leaves:
          - {code: TEC-001, column: TEC_001, site: offshore, type: minmax, absent: 1}
          - {code: TEC-002, column: TEC_002, site: onshore, type: minmax, absent: 1}
"""


def test_offshore_leaves_are_errors_without_a_sea():
    assert model_store.mesh_errors(OFFSHORE_MODEL, has_sea=True) == []
    errors = model_store.mesh_errors(OFFSHORE_MODEL, has_sea=False)
    assert len(errors) == 1
    assert errors[0]["severity"] == "error" and "wind/speed/TEC-001" in errors[0]["message"]
    assert errors[0]["line"] is not None


def test_offshore_run_is_refused_without_a_sea(data_dir, engine_countries, tmp_path, monkeypatch):
    folder = tmp_path / "p"
    row = _row(mesh_id="natural_earth:URY", mesh_source="natural_earth", mesh_country="URY",
               out_folder=str(folder))
    store.add_project(row)
    with pytest.raises(HTTPException) as refused:
        main.start_model_run(row.id, ModelRunPayload(site="offshore"))
    assert refused.value.status_code == 400 and "two projects" in refused.value.detail

    model_store.write_model(row, OFFSHORE_MODEL)
    with pytest.raises(HTTPException) as refused:
        main.start_model_run(row.id, ModelRunPayload(site="both"))
    assert refused.value.status_code == 400 and "TEC-001" in refused.value.detail


# ── the run's progress ────────────────────────────────────────────────────


def test_preparing_another_mesh_is_step_three_of_the_run():
    """
    On a mesh other than Colombia (DANE) the engine's step 3 is
    `prepare_mesh.py`, not `normalize_dane_mgn.py`. Its summary in the run
    manifest must close step 3, or the run shows it skipped although it ran.
    """
    from app import pipeline

    stage = pipeline.STAGES_BY_KEY["normalize_dane"]
    scripts = {s.rsplit("/", 1)[-1].removesuffix(".py") for s in (stage.script, *stage.aliases)}
    assert scripts == {"normalize_dane_mgn", "prepare_mesh"}
    assert any(marker == "preparando la malla" and key == "normalize_dane"
               for marker, key, _ in pipeline.STAGE_LOG_MARKERS)


# ── an upload named like the record ───────────────────────────────────────


@pytest.mark.parametrize("filename", ["mesh.json", "MESH.JSON", "Mesh.json"])
def test_an_upload_named_like_the_record_keeps_its_geometry(data_dir, tmp_path, filename):
    body = _geojson([_polygon_feature("Norte", "N1"), _polygon_feature("Sur", "S1", -73.0)])
    record = meshes.save_upload(filename, io.BytesIO(body))
    kept = meshes.upload_root() / record["id"] / record["file"]
    # Still the outline that was uploaded, not the record about it.
    assert json.loads(kept.read_text(encoding="utf-8"))["type"] == "FeatureCollection"
    assert meshes.read_upload(record["id"])["id"] == record["id"]
    folder = tmp_path / "project"
    row = _row(out_folder=str(folder), **meshes.store_fields(
        meshes.resolve(f"file:{record['id']}")))
    assert meshes.materialise(row) == ""
    copied = folder / "mesh" / record["file"]
    assert json.loads(copied.read_text(encoding="utf-8"))["type"] == "FeatureCollection"


def test_an_upload_from_before_the_record_was_renamed_still_reads(data_dir):
    body = _geojson([_polygon_feature("Norte", "N1")])
    record = meshes.save_upload("zones.geojson", io.BytesIO(body))
    folder = meshes.upload_root() / record["id"]
    (folder / meshes.RECORD_FILE).rename(folder / "mesh.json")
    assert meshes.read_upload(record["id"])["file"] == "zones.geojson"


def test_an_old_upload_whose_file_the_record_overwrote_is_gone(data_dir):
    upload_id = "u-0123456789ab"
    folder = meshes.upload_root() / upload_id
    folder.mkdir(parents=True)
    (folder / "mesh.json").write_text(json.dumps(
        {"id": upload_id, "file": "mesh.json", "files": ["mesh.json"], "columns": []}),
        encoding="utf-8")
    assert meshes.read_upload(upload_id) is None
    with pytest.raises(meshes.MeshError, match="gone"):
        meshes.resolve(f"file:{upload_id}")


# ── every old slug ran on Colombia (DANE) ─────────────────────────────────


@pytest.mark.parametrize("old_id", ["uruguay", "dem_rep_congo", "france", "Colombia"])
def test_every_legacy_slug_is_colombia_dane(engine_countries, old_id):
    assert meshes.legacy_id(old_id) == "dane_colombia"


def test_a_legacy_project_on_another_slug_runs_as_before(data_dir, engine_countries):
    row = _row(mesh_id="uruguay", mesh_label="Uruguay")
    assert meshes.env_for(row) == {**EMPTY, "MESH_SOURCE": "dane_colombia"}
    assert meshes.has_sea(row) is True


# ── the code column ───────────────────────────────────────────────────────


def _feature(properties: dict, x: float = -74.0) -> dict:
    return {"type": "Feature", "properties": properties,
            "geometry": {"type": "Polygon", "coordinates": _square(x)}}


def test_only_columns_that_can_code_every_area_are_suggested(data_dir):
    body = _geojson([
        _feature({"nombre": "Norte", "codigo": "A", "id": "1", "cod": "X"}),
        _feature({"nombre": "Sur", "codigo": "A", "id": "", "cod": "Y"}, -73.0),
    ])
    record = meshes.save_upload("zones.geojson", io.BytesIO(body))
    # `codigo` repeats and `id` has an empty value: neither can code the areas.
    assert record["codeField"] == "cod"
    assert "codigo" not in record["codeColumns"] and "id" not in record["codeColumns"]
    assert {"codigo", "id"} <= set(record["columns"])
    mesh = meshes.as_mesh(record)
    assert mesh["codeColumns"] == record["codeColumns"]


def test_no_code_is_suggested_when_no_column_qualifies(data_dir):
    body = _geojson([_feature({"codigo": "A"}), _feature({"codigo": "A"}, -73.0)])
    record = meshes.save_upload("zones.geojson", io.BytesIO(body))
    assert record["codeField"] == "" and record["codeColumns"] == []


def test_picking_a_code_column_with_repeats_or_blanks_is_refused(data_dir, engine_countries):
    body = _geojson([
        _feature({"nombre": "Norte", "codigo": "A", "id": None}),
        _feature({"nombre": "Sur", "codigo": "A", "id": "2"}, -73.0),
    ])
    record = meshes.save_upload("zones.geojson", io.BytesIO(body))
    with pytest.raises(meshes.MeshError, match="repeated.*A"):
        meshes.resolve(f"file:{record['id']}", code_field="codigo")
    with pytest.raises(meshes.MeshError, match="empty"):
        meshes.resolve(f"file:{record['id']}", code_field="id")
    with pytest.raises(HTTPException) as refused:
        main.create_project(NewProjectPayload(name="X", meshId=f"file:{record['id']}",
                                              meshCodeField="codigo"))
    assert refused.value.status_code == 400 and "codigo" in refused.value.detail
    # A name column may repeat: two areas can share a name.
    assert meshes.resolve(f"file:{record['id']}", name_field="nombre").name_field == "nombre"


def test_an_upload_recorded_before_code_columns_were_checked_is_checked_on_pick(data_dir):
    body = _geojson([_feature({"codigo": "A"}), _feature({"codigo": "A"}, -73.0)])
    record = meshes.save_upload("zones.geojson", io.BytesIO(body))
    path = meshes.upload_root() / record["id"] / meshes.RECORD_FILE
    old = json.loads(path.read_text(encoding="utf-8"))
    for key in ("codeColumns", "codeProblems"):
        old.pop(key, None)
    path.write_text(json.dumps(old), encoding="utf-8")
    with pytest.raises(meshes.MeshError, match="repeated"):
        meshes.resolve(f"file:{record['id']}", code_field="codigo")


def test_integer_columns_can_name_and_code(data_dir, engine_countries):
    body = _geojson([
        _feature({"nombre": "Norte", "dane": 5001, "real": 5001.0, "ratio": 0.5}),
        _feature({"nombre": "Sur", "dane": 5002, "real": 5002.0, "ratio": 1.5}, -73.0),
    ])
    record = meshes.save_upload("zones.geojson", io.BytesIO(body))
    assert {"dane", "real"} <= set(record["columns"])
    assert {"dane", "real"} <= set(record["codeColumns"])
    # A column of fractions is a measure, not a name or a code.
    assert "ratio" not in record["columns"]
    assert meshes.resolve(f"file:{record['id']}", code_field="dane").code_field == "dane"


def test_integer_valued_floats_read_without_a_trailing_zero(data_dir):
    import geopandas as gpd

    body = _geojson([
        _feature({"real": 5001.0}),
        _feature({"real": 5002.0}, -73.0),
    ])
    record = meshes.save_upload("zones.geojson", io.BytesIO(body))
    kept = meshes.upload_root() / record["id"] / record["file"]
    # The engine reads each code as `str(value)`: from the kept copy that is
    # "5001", not "5001.0".
    frame = gpd.read_file(kept)
    assert [str(value) for value in frame["real"]] == ["5001", "5002"]
    assert meshes.cell_text(5001.0) == "5001" and meshes.cell_text(float("nan")) == ""
    assert meshes.cell_text(" N1 ") == "N1" and meshes.cell_text(None) == ""


def test_repeated_integer_codes_are_named_without_a_trailing_zero(data_dir):
    body = _geojson([_feature({"real": 7.0}), _feature({"real": 7.0}, -73.0)])
    record = meshes.save_upload("zones.geojson", io.BytesIO(body))
    with pytest.raises(meshes.MeshError) as refused:
        meshes.resolve(f"file:{record['id']}", code_field="real")
    assert "(7)" in str(refused.value) and "7.0" not in str(refused.value)


# ── deleting a project ────────────────────────────────────────────────────


def test_deleting_a_project_removes_its_upload(data_dir, tmp_path, engine_countries, monkeypatch):
    monkeypatch.setattr(main.inputs, "scan", lambda row: [])
    body = _geojson([_polygon_feature("Norte", "N1")])
    record = meshes.save_upload("zones.geojson", io.BytesIO(body))
    first = main.create_project(NewProjectPayload(
        name="One", meshId=f"file:{record['id']}", outFolder=str(tmp_path / "one")))
    second = main.create_project(NewProjectPayload(
        name="Two", meshId=f"file:{record['id']}", outFolder=str(tmp_path / "two")))
    folder = meshes.upload_root() / record["id"]

    main.delete_project(first.id)
    # Still used by the other project.
    assert folder.is_dir()
    main.delete_project(second.id)
    assert not folder.exists()
    # The copies in the projects' own folders are the user's, and stay.
    assert (tmp_path / "one" / "mesh" / "zones.geojson").is_file()
    assert (tmp_path / "two" / "mesh" / "zones.geojson").is_file()
