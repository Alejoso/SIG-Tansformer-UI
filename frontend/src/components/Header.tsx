import * as modelRun from '../lib/model-run';
import { useApp } from '../state/app-context';
import { SCREEN_ORDER, type Screen } from '../state/app-context';
import { Icon } from './ui/Icon';

/** Steps that have nothing to show until a project is open. */
const NEEDS_PROJECT: Screen[] = ['data', 'map', 'tune'];

export function Header() {
  const { screen, goTo, project } = useApp();
  const showBreadcrumb = screen !== 'projects' && screen !== 'setup' && project !== null;

  /**
   * A model run going somewhere behind the screen you are on.
   *
   * Here because the dialog can be put away and the Model screen is only
   * one of five: without this, a run in progress would be invisible from
   * the other four and there would be no way back to it.
   */
  const applying = modelRun.useModelRun();
  const live =
    applying &&
    (applying.run.status === 'starting' || applying.run.status === 'running') &&
    !applying.showing &&
    // Not on the Model screen: the Apply button is already saying it there,
    // and is the thing to press. Two of them would just be noise.
    screen !== 'tune';

  return (
    <header className="header">
      <button type="button" className="header-brand" onClick={() => goTo('projects')}>
        <Icon name="hexagon" size={26} color="var(--color-accent)" />
        <span>Maphex</span>
      </button>

      <nav className="stepper" aria-label="Project steps">
        {SCREEN_ORDER.map((step) => {
          // The mockup lets you jump anywhere; here the later steps stay
          // disabled until there is a project for them to act on.
          const locked = NEEDS_PROJECT.includes(step.screen) && !project;
          return (
            <button
              key={step.screen}
              type="button"
              className="step"
              disabled={locked}
              aria-current={screen === step.screen ? 'step' : undefined}
              onClick={() => goTo(step.screen)}
              style={locked ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
            >
              {step.label}
            </button>
          );
        })}
      </nav>

      {live && (
        <button
          type="button"
          className="header-run"
          onClick={() => modelRun.setShowing(true)}
          title="Show what the model is doing"
        >
          <Icon name="spinner" size={13} color="var(--color-accent)" className="spin" />
          <span>Applying the model</span>
          <span className="header-run-percent mono">{applying.run.percent}%</span>
        </button>
      )}

      {showBreadcrumb && (
        <div className="breadcrumb">
          <span>Project</span>
          <Icon name="chevronRight" size={13} />
          <strong>{project.name}</strong>
        </div>
      )}
    </header>
  );
}
