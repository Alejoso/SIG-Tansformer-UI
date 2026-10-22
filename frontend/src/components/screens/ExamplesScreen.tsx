/**
 * The reference for the model file: what every key means, and blocks to start
 * from.
 *
 * Its own screen rather than a dialog, and not in the stepper — it is not a
 * step, it is the thing you open when you are halfway through writing a
 * criterion and cannot remember whether `code` or `column` is the one that
 * has to match the data. A dialog could not hold this much without becoming
 * a page with a close button on it.
 *
 * Everything here describes the engine's schema, so it has one job: say what
 * `MCDA/engine/mcda_score.py` does with each key. Where a key is tolerated
 * but ignored, or defaulted in a way that surprises, it says so — those are
 * the ones that cost an afternoon.
 */

import { useEffect, useState } from 'react';
import * as api from '../../api';
import { queueExample } from '../../lib/model-draft';
import { useApp } from '../../state/app-context';
import type { ModelExample } from '../../types';
import { Icon } from '../ui/Icon';

interface Field {
  name: string;
  required?: boolean;
  what: string;
}

const CRITERION_FIELDS: Field[] = [
  {
    name: 'key',
    required: true,
    what:
      'Its name. The engine writes a folder per criterion under the run, and this is what ' +
      'that folder is called — so it is also the name the map’s Model side shows. Keep it ' +
      'to letters, digits and underscores.',
  },
  {
    name: 'nombre',
    what:
      'A readable name for the engine’s own report. Nothing is scored differently for it. ' +
      'The key is Spanish because the engine is.',
  },
  {
    name: 'weight',
    required: true,
    what:
      'Its share of the final score. The criteria should add to 1. Leave it out and the ' +
      'engine reads 0 — the criterion is computed and then counts for nothing, which looks ' +
      'exactly like it working.',
  },
  {
    name: 'subgroups',
    required: true,
    what: 'The groups beneath it. A criterion with none scores nothing.',
  },
];

const SUBGROUP_FIELDS: Field[] = [
  { name: 'key', required: true, what: 'Its name, and its folder under the criterion’s.' },
  { name: 'nombre', what: 'A readable name, as above.' },
  {
    name: 'weight',
    required: true,
    what: 'Its share of the criterion. The subgroups of one criterion should add to 1.',
  },
  { name: 'leaves', required: true, what: 'The variables it scores.' },
  {
    name: 'combine',
    what:
      '`min` makes the worst leaf decide instead of the average — one protected area is ' +
      'enough to rule a hexagon down, however good the rest is. Anything else means the ' +
      'default, a weighted mean.',
  },
  {
    name: 'absent',
    what:
      'The score for hexagons the variable does not cover at all. Presence layers want ' +
      '`absent: 5`: nothing found there is the good case, and without this they would ' +
      'score nothing rather than well.',
  },
  {
    name: 'domain',
    what:
      '`onshore` or `offshore` limits where `absent` applies, so a land layer does not ' +
      'hand the sea a free 5.',
  },
  {
    name: 'normalize',
    what:
      'Rescales the subgroup’s own result rather than averaging its leaves as they are. ' +
      'A subgroup that sets it is exempt from the leaves-add-to-1 check.',
  },
  {
    name: 'min_coverage',
    what:
      'Refuse to score the subgroup unless this fraction of its weight has data behind it.',
  },
];

const LEAF_FIELDS: Field[] = [
  {
    name: 'column',
    required: true,
    what:
      'The name that has to match the data. It is the column in the master table, which ' +
      'is the variable’s folder with its code uppercased — `SOE_001`, not `SOE-001`. Every ' +
      'run writes the real list to out/maestro/<run>/*.variables.csv. A column that is ' +
      'not in that list is skipped, and the model finishes without ever saying so.',
  },
  {
    name: 'code',
    what:
      'A label, hyphenated by convention: `SOE-001`. It names the leaf in the engine’s ' +
      'report and is what `prioritized` matches against. It does not point at any data — ' +
      'that is `column`’s job, and the two looking alike is the usual confusion.',
  },
  {
    name: 'type',
    required: true,
    what: 'How the values become a score from 1 to 5. The five are below.',
  },
  {
    name: 'site',
    what:
      '`both`, `onshore` or `offshore` — which half of the country the leaf applies to. ' +
      'Anything else never applies, so the leaf is silently skipped. Defaults to `both`.',
  },
  {
    name: 'weight',
    what:
      'Its share of the subgroup. Leave it out and it counts as 1 — so two leaves with no ' +
      'weight add to 2, which is a warning but still an even split.',
  },
  {
    name: 'bins',
    what:
      'For `type: range`. A list of [from, to, score]. `null` is unbounded, and a bin reads ' +
      'as (from, to] — exclusive below, inclusive above. A value outside every bin scores ' +
      'nothing at all.',
  },
  {
    name: 'map',
    what:
      'For `type: map`. An exact value to a score: {"1": 0} is the usual presence layer — ' +
      'where it is present, score 0.',
  },
  {
    name: 'direction',
    what: '`cost` inverts a `minmax` or `zscore` leaf, for a variable where high is bad.',
  },
  {
    name: 'impute',
    what:
      'How to fill gaps before scoring. The file’s own top-level `fill` covers every leaf ' +
      'already; this overrides it for one.',
  },
];

interface TypeRow {
  name: string;
  needs: string;
  what: string;
}

const TYPES: TypeRow[] = [
  {
    name: 'minmax',
    needs: 'nothing',
    what:
      'The range present in the data, stretched onto 1 to 5. The easiest to start with: ' +
      'there are no numbers to choose, because it reads them out of the column.',
  },
  {
    name: 'zscore',
    needs: 'nothing',
    what: 'The same, around the mean — a z of -2 to 2 becomes 1 to 5. Less swayed by one outlier.',
  },
  {
    name: 'range',
    needs: 'bins',
    what: 'Your own cuts. Use it when the thresholds matter more than the spread.',
  },
  {
    name: 'map',
    needs: 'map',
    what: 'An exact value to a score. For categories and presence layers.',
  },
  {
    name: 'direct',
    needs: 'nothing',
    what: 'The value already is a score from 1 to 5. Used as it stands.',
  },
];

const ZONING: Field[] = [
  {
    name: 'exclude_columns',
    what:
      'Any value at all in these columns rules the hexagon out. It comes back marked ' +
      'excluded rather than scored low.',
  },
  {
    name: 'exclude_thresholds',
    what:
      'The same, by a cut on a continuous variable: {code, source_column, op, value, ' +
      'out_column}, where op is lt, le, gt, ge or eq.',
  },
  {
    name: 'prioritized',
    what:
      'Codes kept whatever else is dropped. Running with --only-prioritized uses just ' +
      'these leaves.',
  },
];

function FieldTable({ fields }: { fields: Field[] }) {
  return (
    <dl className="field-list">
      {fields.map((field) => (
        <div key={field.name} className="field-row">
          <dt>
            <code>{field.name}</code>
            {field.required && <span className="field-required">required</span>}
          </dt>
          <dd>{field.what}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ExamplesScreen() {
  const { goTo, showToast } = useApp();
  const [examples, setExamples] = useState<ModelExample[]>([]);

  useEffect(() => {
    let live = true;
    api.listExamples().then((list) => {
      if (live) setExamples(list);
    });
    return () => {
      live = false;
    };
  }, []);

  /**
   * Hand the block to the editor and go back to it.
   *
   * Queued rather than written here: the editor holds the unsaved text, and
   * writing into the file behind it would be overwritten the moment you
   * saved.
   */
  const use = (example: ModelExample) => {
    queueExample(example);
    goTo('tune');
  };

  return (
    <div className="examples-screen">
      <div className="examples-screen-head">
        <button type="button" className="btn btn-ghost" onClick={() => goTo('tune')}>
          <Icon name="chevronRight" size={14} className="icon-flip" />
          Back to the model
        </button>
        <h1>Writing the model</h1>
        <p className="muted">
          The file is the engine&rsquo;s own config, so this describes what{' '}
          <code>mcda_score.py</code> does with each key — not a format this app invented. Every
          block below can be dropped into your file as it stands.
        </p>
      </div>

      <section className="examples-shape" aria-label="The shape of the file">
        <div className="shape-step">
          <span className="shape-level">criteria</span>
          <p>
            The questions you are weighing — wind, cost, who lives there. Their weights add to
            1, and together they are the score on the map.
          </p>
        </div>
        <Icon name="chevronRight" size={16} color="var(--color-accent-400)" />
        <div className="shape-step">
          <span className="shape-level">subgroups</span>
          <p>
            One aspect of a criterion. Their weights add to 1 within it. This is the level that
            can say &ldquo;the worst leaf wins&rdquo; or &ldquo;not covered means fine&rdquo;.
          </p>
        </div>
        <Icon name="chevronRight" size={16} color="var(--color-accent-400)" />
        <div className="shape-step">
          <span className="shape-level">leaves</span>
          <p>
            One variable each. A leaf names a column of the master table and says how its
            values become a score from 1 to 5. This is the only level that touches real data.
          </p>
        </div>
      </section>

      <div className="examples-columns">
        <div className="examples-reference">
          <section className="reference-block">
            <h2>A criterion</h2>
            <FieldTable fields={CRITERION_FIELDS} />
          </section>

          <section className="reference-block">
            <h2>A subgroup</h2>
            <FieldTable fields={SUBGROUP_FIELDS} />
          </section>

          <section className="reference-block">
            <h2>A leaf</h2>
            <p className="reference-lede">
              The one place a name has to match something outside the file. <code>column</code>{' '}
              is the data; <code>code</code> is the label. Getting them the wrong way round is
              the mistake that runs cleanly and scores nothing.
            </p>
            <FieldTable fields={LEAF_FIELDS} />
          </section>

          <section className="reference-block">
            <h2>
              <code>type</code>: turning values into scores
            </h2>
            <div className="type-list">
              {TYPES.map((row) => (
                <div key={row.name} className="type-row">
                  <code className="type-name">{row.name}</code>
                  <span className="type-needs">
                    {row.needs === 'nothing' ? 'no settings' : `needs ${row.needs}`}
                  </span>
                  <p>{row.what}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="reference-block">
            <h2>Zoning</h2>
            <p className="reference-lede">
              Top-level keys, not part of a criterion. They do not score anything — they remove
              hexagons before the model runs. Having any of them in the file is also what makes
              the engine treat it as self-contained, rather than falling back to its own{' '}
              <code>zoning.yaml</code>, which names variables your project does not have.
            </p>
            <FieldTable fields={ZONING} />
          </section>

          <section className="reference-block">
            <h2>What the checks will say</h2>
            <p className="reference-lede">
              The engine refuses nothing in its own config — it prints and carries on. So the
              Model screen separates the two: a <strong>problem</strong> is something the engine
              would crash on or drop in silence, a <strong>warning</strong> is something it
              tolerates. Only YAML that does not parse stops Apply.
            </p>
            <p className="reference-lede">
              The warning worth reading is a key the engine does not know. A mistyped{' '}
              <code>binz:</code> leaves a leaf with no cuts, and the run still finishes.
            </p>
          </section>
        </div>

        <div className="examples-blocks">
          {examples.map((example) => (
            <article key={example.id} className="example-block">
              <header>
                <h3>{example.title}</h3>
                <span className={`example-scope is-${example.scope}`}>
                  {example.scope === 'top' ? 'top level' : 'goes under criteria:'}
                </span>
              </header>
              <p className="muted">{example.blurb}</p>
              <pre className="example-yaml">{example.yaml}</pre>
              <button
                type="button"
                className="btn btn-secondary btn-block"
                onClick={() => use(example)}
                style={{ gap: 8 }}
              >
                <Icon name="copy" size={15} />
                Add to the editor
              </button>
            </article>
          ))}
          {examples.length === 0 && (
            <div className="muted-55" style={{ fontSize: 12.5 }}>
              Loading the examples&hellip;
            </div>
          )}
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => {
              showToast('Back to the model');
              goTo('tune');
            }}
            style={{ height: 42 }}
          >
            Back to the model
          </button>
        </div>
      </div>
    </div>
  );
}
