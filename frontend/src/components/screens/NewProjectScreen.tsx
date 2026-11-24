import { useEffect, useRef, useState } from 'react';
import * as api from '../../api';
import { useApp } from '../../state/app-context';
import type { GeoBoundariesLevel, Mesh, Resolutions } from '../../types';
import { Icon } from '../ui/Icon';
import { SearchableSelect } from '../ui/SearchableSelect';
import { SettingsDialog } from './SettingsDialog';

/** What an upload may be. The server checks it again, and says why when it cannot be a mesh. */
const MESH_UPLOAD_ACCEPT = '.geojson,.json,.gpkg,.parquet,.zip';

/** How finely a country is drawn: its outline, or geoBoundaries' divisions of it. */
type Detail = 'outline' | GeoBoundariesLevel;

const DETAILS: { value: Detail; label: string }[] = [
  { value: 'outline', label: 'Outline (Natural Earth)' },
  { value: 'ADM0', label: 'geoBoundaries ADM0 (the country)' },
  { value: 'ADM1', label: 'geoBoundaries ADM1 (first-level divisions)' },
  { value: 'ADM2', label: 'geoBoundaries ADM2 (second-level divisions)' },
];

export function NewProjectScreen() {
  const { openProject, showHints, showToast } = useApp();

  const [meshes, setMeshes] = useState<Mesh[]>([]);
  /** Uploaded this visit. Kept apart so they sit at the top of the list. */
  const [uploads, setUploads] = useState<Mesh[]>([]);
  const [uploading, setUploading] = useState(false);
  const [name, setName] = useState('');
  /** The row picked in the list. The id sent is `meshId`, which adds the detail. */
  const [pickedId, setPickedId] = useState('');
  const [detail, setDetail] = useState<Detail>('outline');
  /** A country can take its sea too: its exclusive economic zone (`:eez`). */
  const [withSea, setWithSea] = useState(false);
  const [nameField, setNameField] = useState('');
  const [codeField, setCodeField] = useState('');
  const [outFolder, setOutFolder] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  /** The folder dialog blocks this request for as long as it is open. */
  const [choosing, setChoosing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  /**
   * Resolutions chosen before the project exists, written to it once it
   * does. Null means the engine's own, which is what most projects want.
   *
   * They belong here rather than after: the processing resolution decides
   * the size of every hexagon the first run computes, and changing it
   * afterwards rebuilds the master table and reprocesses everything.
   */
  const [resolutions, setResolutions] = useState<Resolutions | null>(null);
  const meshUpload = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    api
      .listMeshes()
      .then((list) => {
        if (!live) return;
        setMeshes(list);
      })
      .catch(() => {
        if (live) showToast('Could not load meshes — is the backend running?');
      });
    return () => {
      live = false;
    };
  }, [showToast]);

  const picked = [...uploads, ...meshes].find((mesh) => mesh.id === pickedId) ?? null;
  // A country picked at geoBoundaries detail is its own mesh to the engine.
  const landId =
    picked && picked.source === 'natural_earth' && picked.geoboundaries && detail !== 'outline'
      ? api.geoboundariesMeshId(picked.iso, detail)
      : pickedId;
  const canTakeSea = picked?.source === 'natural_earth';
  const meshId = canTakeSea && withSea ? `${landId}:eez` : landId;
  const countryCount = meshes.filter((mesh) => mesh.source === 'natural_earth').length;

  const pick = (id: string) => {
    setPickedId(id);
    setDetail('outline');
    setWithSea(false);
    const mesh = [...uploads, ...meshes].find((m) => m.id === id);
    // Suggested, not imposed: the engine finds them itself when left empty.
    setNameField(mesh?.nameField ?? '');
    setCodeField(mesh?.codeField ?? '');
  };

  const uploadMesh = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const mesh = await api.uploadMesh(file);
      setUploads((current) => [mesh, ...current.filter((m) => m.id !== mesh.id)]);
      setPickedId(mesh.id);
      setDetail('outline');
      setNameField(mesh.nameField ?? '');
      setCodeField(mesh.codeField ?? '');
      showToast(`${mesh.label} added`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not upload that mesh');
    } finally {
      setUploading(false);
    }
  };

  /**
   * Ask the server for a native dialog. There often is not one — headless, or
   * WSL without the Tk bindings — so say why rather than appearing to do
   * nothing; the field beside the button always works.
   */
  const chooseFolder = async () => {
    setChoosing(true);
    try {
      const picked = await api.pickFolder(outFolder);
      if (picked.path) setOutFolder(picked.path);
      else if (picked.unavailable) showToast(picked.unavailable);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not open a folder chooser');
    } finally {
      setChoosing(false);
    }
  };

  const create = async () => {
    setCreating(true);
    try {
      const project = await api.createProject({
        name,
        meshId,
        outFolder,
        description,
        ...(picked?.source === 'file' ? { meshNameField: nameField, meshCodeField: codeField } : {}),
      });
      if (resolutions) {
        // Not fatal if it fails: the project exists and would run at the
        // engine's resolution, which is what it would have done anyway. Say
        // so rather than throw away a project that was created.
        try {
          await api.saveSettings(project.id, resolutions);
        } catch {
          showToast('Project created, but its resolution could not be saved');
        }
      }
      openProject(project, 'data');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not create the project');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="screen setup-screen">
      <div className="screen-body">
        <div className="setup-head">
          <div>
            <h1>Start a new project</h1>
            <p className="muted">
              Name it, pick the map area you are working in, and we will take care of the hexagons.
            </p>
          </div>
          {/* Here because the processing resolution has to be settled before
              the first run, not after it. */}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShowSettings(true)}
            style={{ flex: 'none', gap: 8 }}
          >
            <Icon name="sliders" />
            {resolutions
              ? `Res ${resolutions.processingResolution} · map ${resolutions.mapResolution}`
              : 'Resolution'}
          </button>
        </div>

        <div className="card elev-sm setup-card">
          <div className="field">
            <label htmlFor="project-name">Project name</label>
            <input
              id="project-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ridgeline Wind — Phase 2"
            />
          </div>

          <div className="field">
            <label htmlFor="project-mesh">Map mesh</label>
            <div className="field-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <SearchableSelect
                  id="project-mesh"
                  options={[...uploads, ...meshes].map((mesh) => ({
                    id: mesh.id,
                    label: mesh.label,
                    hint:
                      mesh.source === 'file'
                        ? 'Uploaded'
                        : mesh.recommended
                          ? 'Recommended for Colombia'
                          : mesh.continent,
                    search: mesh.search,
                  }))}
                  value={pickedId}
                  onChange={pick}
                  placeholder={countryCount ? `Search ${countryCount} countries…` : 'Search countries…'}
                  emptyText="No country matches that"
                />
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => meshUpload.current?.click()}
                disabled={uploading}
                style={{ gap: 7, flex: 'none' }}
              >
                {uploading ? (
                  <Icon name="spinner" size={15} className="spin" />
                ) : (
                  <Icon name="upload" size={15} />
                )}
                {uploading ? 'Checking…' : 'Upload'}
              </button>
              <input
                ref={meshUpload}
                type="file"
                accept={MESH_UPLOAD_ACCEPT}
                hidden
                onChange={(e) => {
                  void uploadMesh(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </div>
            {showHints && (
              <p className="field-hint muted-55">
                The area you want to study. Colombia (DANE) is the one for Colombia: its
                municipalities and its sea. Any other country comes from Natural Earth. Or upload
                your own outline: GeoJSON, GeoPackage, GeoParquet, or a shapefile zipped with its
                .shx, .dbf and .prj.
              </p>
            )}
            {picked && !picked.hasSea && !(canTakeSea && withSea) && (
              <p className="field-hint muted-55" data-testid="mesh-no-sea">
                {picked.source === 'natural_earth' && picked.country === 'COL'
                  ? 'For Colombia, Colombia (DANE) is the recommended mesh: it has the municipalities and the sea. '
                  : ''}
                This mesh has no sea, so fills cover the whole area and the model has no offshore
                site.{' '}
                {canTakeSea
                  ? 'Include its sea below to add its exclusive economic zone.'
                  : 'Onshore and offshore need two projects.'}
              </p>
            )}
          </div>

          {picked?.source === 'natural_earth' && (
            <div className="field">
              <label htmlFor="project-mesh-detail">Detail</label>
              <select
                id="project-mesh-detail"
                className="input"
                value={detail}
                onChange={(e) => setDetail(e.target.value as Detail)}
              >
                {DETAILS.map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                    disabled={option.value !== 'outline' && !picked.geoboundaries}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
              {!picked.geoboundaries ? (
                <p className="field-hint muted-55">
                  geoBoundaries is keyed by ISO code, and Natural Earth gives {picked.label} none,
                  so only its outline is offered.
                </p>
              ) : detail !== 'outline' ? (
                <p className="field-hint muted-55">
                  The engine downloads it from geoBoundaries on the first run, so that run needs
                  internet. Boundaries: geoBoundaries (CC BY 4.0), www.geoboundaries.org.
                </p>
              ) : (
                showHints && (
                  <p className="field-hint muted-55">
                    The country as one outline. geoBoundaries adds its divisions, so each hexagon
                    knows which one it is in.
                  </p>
                )
              )}
            </div>
          )}

          {canTakeSea && (
            <div className="field">
              <label className="settings-option" htmlFor="project-mesh-sea">
                <input
                  id="project-mesh-sea"
                  type="checkbox"
                  checked={withSea}
                  onChange={(e) => setWithSea(e.target.checked)}
                />
                <span>
                  <span className="settings-option-label">Include its sea</span>
                  <span className="field-hint muted-55">
                    Adds the country&apos;s exclusive economic zone, so fills can use the sea and
                    the model can score offshore. The engine downloads it on the first run
                    (needs internet). Maritime boundaries: Marine Regions (CC BY 4.0),
                    www.marineregions.org.
                  </span>
                </span>
              </label>
            </div>
          )}

          {picked?.source === 'file' && (
            <div className="field">
              <label htmlFor="project-mesh-name">Name and code columns</label>
              <div className="field-row">
                <select
                  id="project-mesh-name"
                  className="input"
                  aria-label="Name column"
                  value={nameField}
                  onChange={(e) => setNameField(e.target.value)}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  <option value="">Name: find it automatically</option>
                  {(picked.columns ?? []).map((column) => (
                    <option key={column} value={column}>
                      Name: {column}
                    </option>
                  ))}
                </select>
                <select
                  id="project-mesh-code"
                  className="input"
                  aria-label="Code column"
                  value={codeField}
                  onChange={(e) => setCodeField(e.target.value)}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  <option value="">Code: find it automatically</option>
                  {(picked.codeColumns ?? picked.columns ?? []).map((column) => (
                    <option key={column} value={column}>
                      Code: {column}
                    </option>
                  ))}
                </select>
              </div>
              <p className="field-hint muted-55">
                {picked.featureCount ?? 0} area{picked.featureCount === 1 ? '' : 's'} in this{' '}
                {picked.format || 'file'}. The columns that name and code each one are optional; a code
                column needs a value for every area, none repeated.
                {(picked.notes ?? []).map((note) => ` ${note}`).join('')}
              </p>
            </div>
          )}

          <div className="field">
            <label htmlFor="out-folder">Results folder</label>
            <div className="field-row">
              <input
                id="out-folder"
                className="input"
                value={outFolder}
                onChange={(e) => setOutFolder(e.target.value)}
                placeholder="e.g. /Projects/Ridgeline/results"
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={chooseFolder}
                disabled={choosing}
                style={{ gap: 7, flex: 'none' }}
              >
                {choosing ? (
                  <Icon name="spinner" size={15} className="spin" />
                ) : (
                  <Icon name="folder" size={15} />
                )}
                {choosing ? 'Choosing…' : 'Choose'}
              </button>
            </div>
            {showHints && (
              <p className="field-hint muted-55">
                Where we save the processed files. Pick an empty folder if you can.
              </p>
            )}
          </div>

          <div className="field">
            <label htmlFor="project-desc">
              Description <span style={{ opacity: 0.6 }}>— optional</span>
            </label>
            <textarea
              id="project-desc"
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What are you trying to find out?"
              style={{ borderRadius: 'var(--radius-lg)', minHeight: 84 }}
            />
          </div>

          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={create}
            disabled={creating || !name.trim() || !meshId}
            style={{ height: 44, fontSize: 15 }}
          >
            {creating ? 'Creating…' : 'Create Project'}
          </button>
        </div>
      </div>

      {showSettings && (
        <SettingsDialog
          projectId={null}
          chosen={resolutions}
          onChoose={setResolutions}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
