import { useEffect, useRef, useState } from 'react';
import * as api from '../../api';
import { useApp } from '../../state/app-context';
import type { Mesh } from '../../types';
import { Icon } from '../ui/Icon';
import { SettingsDialog } from './SettingsDialog';

export function NewProjectScreen() {
  const { openProject, showHints, showToast } = useApp();

  const [meshes, setMeshes] = useState<Mesh[]>([]);
  const [name, setName] = useState('');
  const [meshId, setMeshId] = useState('');
  const [outFolder, setOutFolder] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const meshUpload = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    api.listMeshes().then((list) => {
      if (!live) return;
      setMeshes(list);
      setMeshId((current) => current || list[0]?.id || '');
    });
    return () => {
      live = false;
    };
  }, []);

  const uploadMesh = async (file: File | undefined) => {
    if (!file) return;
    const mesh = await api.uploadMesh(file);
    setMeshes((current) => [mesh, ...current.filter((m) => m.id !== mesh.id)]);
    setMeshId(mesh.id);
    showToast(`${mesh.label} added`);
  };

  /**
   * Ask the server for a native dialog. There often is not one — headless, or
   * WSL without the Tk bindings — so say why rather than appearing to do
   * nothing; the field beside the button always works.
   */
  const chooseFolder = async () => {
    const picked = await api.pickFolder();
    if (picked.path) setOutFolder(picked.path);
    else if (picked.unavailable) showToast(picked.unavailable);
  };

  const create = async () => {
    setCreating(true);
    try {
      const project = await api.createProject({ name, meshId, outFolder, description });
      openProject(project, 'data');
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
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShowSettings(true)}
            style={{ flex: 'none', gap: 8 }}
          >
            <Icon name="sliders" />
            Config
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
              <select
                id="project-mesh"
                className="input"
                value={meshId}
                onChange={(e) => setMeshId(e.target.value)}
                style={{ flex: 1, paddingRight: 12 }}
              >
                {meshes.map((mesh) => (
                  <option key={mesh.id} value={mesh.id}>
                    {mesh.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => meshUpload.current?.click()}
                style={{ gap: 7, flex: 'none' }}
              >
                <Icon name="upload" size={15} />
                Upload
              </button>
              <input
                ref={meshUpload}
                type="file"
                accept=".geojson,application/geo+json"
                hidden
                onChange={(e) => {
                  void uploadMesh(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </div>
            {showHints && (
              <p className="field-hint muted-55">
                The mesh is the outline of the area you want to study. Pick a saved one or upload
                your own.
              </p>
            )}
          </div>

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
                style={{ gap: 7, flex: 'none' }}
              >
                <Icon name="folder" size={15} />
                Choose
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

      {showSettings && <SettingsDialog projectId={null} onClose={() => setShowSettings(false)} />}
    </div>
  );
}
