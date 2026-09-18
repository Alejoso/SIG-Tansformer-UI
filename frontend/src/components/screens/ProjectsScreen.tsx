import { useEffect, useState } from 'react';
import * as api from '../../api';
import { useApp } from '../../state/app-context';
import { RAMP_INPUT, rampCss } from '../../lib/ramp';
import type { Project } from '../../types';
import { Icon } from '../ui/Icon';

const SWATCH = `linear-gradient(135deg,${rampCss(RAMP_INPUT, 0.15)},${rampCss(RAMP_INPUT, 0.85)})`;

/** "6 variables · 4,812 hexagons · 2 days ago", or the draft equivalent. */
function detailLine(project: Project): string {
  if (project.status === 'draft') return project.updatedAt;
  return [
    `${project.variableCount} variables`,
    `${project.hexagonCount.toLocaleString()} hexagons`,
    project.updatedAt,
  ].join(' · ');
}

export function ProjectsScreen() {
  const { goTo, openProject } = useApp();
  const [projects, setProjects] = useState<Project[] | null>(null);

  useEffect(() => {
    let live = true;
    api.listProjects().then((list) => {
      if (live) setProjects(list);
    });
    return () => {
      live = false;
    };
  }, []);

  if (projects === null) {
    return (
      <div className="screen-loading">
        <Icon name="spinner" size={22} color="var(--color-accent)" className="spin" />
      </div>
    );
  }

  return (
    <div className="screen projects-screen">
      <div className="screen-body">
        {projects.length === 0 ? (
          <div className="projects-empty">
            <div className="projects-empty-icon">
              <Icon name="hexagon" size={36} color="var(--color-accent)" />
            </div>
            <h1>No projects yet</h1>
            <p className="muted">
              A project holds one map area and the data you want to look at on it. Making one takes
              a minute.
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => goTo('setup')}
              style={{ height: 44, paddingInline: 26, fontSize: 15, marginTop: 6 }}
            >
              Create your first project
            </button>
          </div>
        ) : (
          <>
            <h1 className="projects-title">Your projects</h1>
            <p className="projects-lede muted">Pick up where you left off, or start something new.</p>

            <div className="projects-grid">
              {projects.map((project) => {
                const processed = project.status === 'processed';
                return (
                  <button
                    key={project.id}
                    type="button"
                    className="card elev-sm project-card"
                    onClick={() => openProject(project, processed ? 'map' : 'data')}
                  >
                    <div className="project-card-head">
                      <div className="project-swatch" style={{ background: SWATCH }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="card-title" style={{ fontSize: 18 }}>
                          {project.name}
                        </div>
                        <div className="project-mesh muted-55">{project.meshLabel}</div>
                      </div>
                    </div>

                    <div className="project-card-meta">
                      <span className={`project-status ${processed ? 'is-processed' : 'is-draft'}`}>
                        {processed ? 'Processed' : 'Draft'}
                      </span>
                      <span className="project-detail muted-50">{detailLine(project)}</span>
                    </div>

                    <div className="project-action">
                      {processed ? 'Open map' : 'Finish setup'}
                      <Icon name="chevronRight" size={14} />
                    </div>
                  </button>
                );
              })}

              <button type="button" className="project-new" onClick={() => goTo('setup')}>
                <div className="project-new-icon">
                  <Icon name="plus" size={19} color="var(--color-accent-800)" />
                </div>
                <div className="project-new-title">New project</div>
                <div className="muted-55" style={{ fontSize: 12 }}>
                  Start from a mesh and your data folders
                </div>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
