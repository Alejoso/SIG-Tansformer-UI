"""
A project's switches for its runs, each with its own default: the CSVs and
keeping awake are off unless turned on; the H3 code in the map tooltips is on
unless turned off (as the engine has drawn it since 2026-11-20).
"""

from __future__ import annotations

from app import settings as project_settings
from app import store


def _row(**columns) -> store.ProjectRow:
    return store.ProjectRow(id="p-a", name="a", mesh_id="dane_colombia", mesh_label="", **columns)


def test_a_project_that_never_chose_runs_on_the_defaults():
    options = project_settings.options_of(_row())
    assert options.mapTooltipH3 and not options.scoreStatsCsv and not options.masterCsv
    env = project_settings.option_env(_row())
    assert env["MAP_TOOLTIP_H3"] == "1" and env["MCDA_STATS_CSV"] == "0" and env["EXPORT_CSV"] == "0"


def test_each_switch_reaches_the_engine(data_dir):
    store.write_projects([_row()])
    saved = project_settings.save_options(
        store.find_project("p-a"),
        project_settings.Options(mapTooltipH3=False, scoreStatsCsv=True),
    )
    assert saved.map_tooltip_h3 == "0" and saved.mcda_stats_csv == "1"
    env = project_settings.option_env(saved)
    assert env["MAP_TOOLTIP_H3"] == "0" and env["MCDA_STATS_CSV"] == "1"
    back = project_settings.save_options(saved, project_settings.Options())
    # back on the defaults: nothing written, so a later change of default reaches it
    assert back.map_tooltip_h3 == "" and back.mcda_stats_csv == ""
    assert project_settings.option_env(back)["MAP_TOOLTIP_H3"] == "1"


def test_default_values_puts_every_switch_back_on_its_default(data_dir):
    store.write_projects([_row(map_tooltip_h3="0", mcda_stats_csv="1", export_csv="1")])
    cleared = project_settings.clear(store.find_project("p-a"))
    options = project_settings.options_of(cleared)
    assert options == project_settings.Options()
    assert options.mapTooltipH3 and not options.scoreStatsCsv and not options.masterCsv
