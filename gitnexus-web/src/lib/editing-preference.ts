/**
 * Per-repository "editing enabled" preference.
 *
 * This is a convenience gate, not a security boundary — the server has its own
 * independent `--allow-file-writes` gate. Its job is to keep the Code Inspector
 * read-only by default so a stray keystroke cannot modify the working tree.
 */

const KEY_PREFIX = 'gitnexus.editing.';

const keyFor = (repo: string | undefined): string => `${KEY_PREFIX}${repo ?? '__none__'}`;

export const isEditingEnabledForRepo = (repo: string | undefined): boolean => {
  try {
    return window.localStorage.getItem(keyFor(repo)) === '1';
  } catch {
    // Private mode or storage disabled — default to read-only.
    return false;
  }
};

export const setEditingEnabledForRepo = (repo: string | undefined, enabled: boolean): void => {
  try {
    window.localStorage.setItem(keyFor(repo), enabled ? '1' : '0');
  } catch {
    // Preference is best-effort; editing still works for this session.
  }
};
