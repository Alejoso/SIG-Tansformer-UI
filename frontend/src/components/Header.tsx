import { useApp } from '../state/app-context';
import { SCREEN_ORDER, type Screen } from '../state/app-context';
import { Icon } from './ui/Icon';

/** Steps that have nothing to show until a project is open. */
const NEEDS_PROJECT: Screen[] = ['data', 'map', 'tune'];

export function Header() {
  const { screen, goTo, project } = useApp();
  const showBreadcrumb = screen !== 'projects' && screen !== 'setup' && project !== null;

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
