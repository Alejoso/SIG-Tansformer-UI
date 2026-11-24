/**
 * Choosing a folder without a native dialog.
 *
 * The server opens the machine's own folder chooser when it can. In Docker it
 * cannot — there is no desktop in a container — so this walks the server's
 * folders one level at a time instead. The paths are the server's, which in
 * Docker are the host's own (they are mounted at the same place).
 */

import { useEffect, useRef, useState } from 'react';
import * as api from '../../api';
import type { FolderListing } from '../../types';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

interface FolderBrowserProps {
  /** Where to open: usually what is already in the field. */
  startAt?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}

export function FolderBrowser({ startAt, onPick, onClose }: FolderBrowserProps) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const list = useRef<HTMLDivElement>(null);
  /** The new folder's name while it is being typed; null when not making one. */
  const [newName, setNewName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const open = async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      setListing(await api.listFolders(path));
      // A new folder starts at its top, not where the last one was scrolled.
      list.current?.scrollTo({ top: 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that folder');
    } finally {
      setLoading(false);
    }
  };

  /** Make the folder where the browser is standing, and go into it. */
  const createFolder = async () => {
    if (!listing || newName === null) return;
    setCreating(true);
    setError(null);
    try {
      setListing(await api.createFolder(listing.path, newName));
      setNewName(null);
      list.current?.scrollTo({ top: 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create that folder');
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => {
    void open(startAt?.trim() || undefined);
    // Only where it opens; after that the user moves it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Dialog onClose={onClose} width="min(560px, 100%)" labelledBy="folder-browser-title">
      <div className="dialog-title" id="folder-browser-title">
        Choose a folder
      </div>

      <div className="folder-browser-path">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => listing?.parent && void open(listing.parent)}
          disabled={loading || !listing?.parent}
        >
          Up
        </button>
        <span className="mono folder-browser-current" title={listing?.path}>
          {listing?.path ?? '…'}
        </span>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setNewName('');
            setError(null);
          }}
          disabled={loading || !listing || newName !== null}
        >
          <Icon name="plus" size={14} />
          New folder
        </button>
      </div>

      {newName !== null && (
        <form
          className="folder-browser-new"
          onSubmit={(e) => {
            e.preventDefault();
            void createFolder();
          }}
        >
          <input
            className="input"
            aria-label="New folder name"
            placeholder="New folder name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              // Escape leaves the name, not the whole browser.
              if (e.key === 'Escape') {
                e.stopPropagation();
                setNewName(null);
                setError(null);
              }
            }}
            autoFocus
            disabled={creating}
          />
          <button type="submit" className="btn btn-primary" disabled={creating || !newName.trim()}>
            {creating ? 'Creating…' : 'Create'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setNewName(null);
              setError(null);
            }}
            disabled={creating}
          >
            Cancel
          </button>
        </form>
      )}

      <div ref={list} className="folder-browser-list" aria-busy={loading}>
        {listing?.folders.map((folder) => (
          <button
            key={folder.path}
            type="button"
            className="folder-browser-row"
            onClick={() => void open(folder.path)}
            disabled={loading}
          >
            <Icon name="folder" size={15} />
            <span className="folder-browser-name">{folder.name}</span>
            <Icon name="chevronRight" size={14} />
          </button>
        ))}
        {listing && listing.folders.length === 0 && !loading && (
          <p className="muted-55 folder-browser-empty">No folders inside this one.</p>
        )}
      </div>
      {error && <p className="settings-note is-error">{error}</p>}

      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => listing && onPick(listing.path)}
          disabled={loading || creating || !listing}
        >
          Use this folder
        </button>
      </div>
    </Dialog>
  );
}
