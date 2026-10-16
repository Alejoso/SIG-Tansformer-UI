import { useEffect, useState } from 'react';
import * as api from '../../api';
import { useApp } from '../../state/app-context';
import { RAMP_INPUT, rampCss } from '../../lib/ramp';
import type { Project } from '../../types';
import { Icon } from '../ui/Icon';

const SWATCH = `linear-gradient(135deg,${rampCss(RAMP_INPUT, 0.15)},${rampCss(RAMP_INPUT, 0.85)})`;

/** "3 folders · 2 days ago", with the hexagon count once there is one. */
function detailLine(project: Project): string {
  const parts = [
    `${project.variableCount} ${project.variableCount === 1 ? 'folder' : 'folders'}`,
  ];
  if (project.hexagonCount > 0) parts.push(`${project.hexagonCount.toLocaleString()} hexagons`);
  if (project.updatedAt) parts.push(formatWhen(project.updatedAt));
  return parts.join(' · ');
}

/** The server stores ISO timestamps; nobody wants to read one on a card. */
function formatWhen(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;

  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  return new Date(then).toLocaleDateString();
}

export function ProjectsScreen() {
  const { goTo, openProject } = useApp();
  const [projects, setProjects] = useState<Project[] | null>(null);
  /**
   * The last failure, tagged with the attempt it belongs to. Comparing during
   * render clears it when Try again starts a new attempt, without an effect
   * reaching back to reset it.
   */
  const [failed, setFailed] = useState<{ attempt: number; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const failure = failed?.attempt === attempt ? failed.message : null;

  useEffect(() => {
    let live = true;
    api
      .listProjects()
      .then((list) => {
        if (live) setProjects(list);
      })
      .catch((error: unknown) => {
        // Without this the screen spins forever when the backend is not
        // running, which looks like the app is broken rather than like
        // something simply has not been started.
        if (live) {
          setFailed({
            attempt,
            message: error instanceof Error ? error.message : 'Could not reach the backend',
          });
        }
      });
    return () => {
      live = false;
    };
  }, [attempt]);

  if (failure) {
    return (
      <div className="screen projects-screen">
        <div className="screen-body">
          <div className="projects-empty">
            <div className="projects-empty-icon is-problem">
              <Icon name="close" size={34} color="var(--color-accent-800)" />
            </div>
            <h1>Cannot reach the backend</h1>
            <p className="muted">
              Projects are stored by the local server, so nothing can be listed without it. Start it
              with <code className="mono">cd backend &amp;&amp; ./run.sh</code> and try again.
            </p>
            <p className="muted-50" style={{ fontSize: 12.5, maxWidth: 460 }}>
              {failure}
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setProjects(null);
                setAttempt((n) => n + 1);
              }}
              style={{ height: 44, paddingInline: 26, fontSize: 15, marginTop: 6 }}
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

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
                      {/* Flagged here so a project the engine would partly
                          skip is visible without opening it — the server
                          rereads the input tree on each request. */}
                      {project.unreadableVariables > 0 && (
                        <span className="project-status is-missing">
                          {project.unreadableVariables} variable
                          {project.unreadableVariables === 1 ? '' : 's'} unreadable
                        </span>
                      )}
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
