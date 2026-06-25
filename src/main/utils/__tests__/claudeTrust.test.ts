import { describe, expect, it } from 'vitest';

import { applyFolderTrust } from '../claudeTrust';

describe('applyFolderTrust', () => {
  it('adds a trusted project entry on a config with no projects', () => {
    const { cfg, changed } = applyFolderTrust({}, '/wt/a');
    expect(changed).toBe(true);
    const projects = cfg.projects as Record<string, Record<string, unknown>>;
    expect(projects['/wt/a']).toMatchObject({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    });
  });

  it('preserves other projects and existing fields', () => {
    const cfg = {
      numStartups: 5,
      projects: { '/other': { hasTrustDialogAccepted: true, foo: 1 } },
    };
    const { cfg: out, changed } = applyFolderTrust(cfg, '/wt/b');
    expect(changed).toBe(true);
    const projects = out.projects as Record<string, Record<string, unknown>>;
    expect(projects['/other']).toEqual({ hasTrustDialogAccepted: true, foo: 1 });
    expect(projects['/wt/b'].hasTrustDialogAccepted).toBe(true);
    expect(out.numStartups).toBe(5);
  });

  it('is a no-op (changed=false) when the folder is already trusted', () => {
    const cfg = { projects: { '/wt/c': { hasTrustDialogAccepted: true } } };
    const { changed } = applyFolderTrust(cfg, '/wt/c');
    expect(changed).toBe(false);
  });

  it('flips an explicitly-untrusted folder to trusted', () => {
    const cfg = { projects: { '/wt/d': { hasTrustDialogAccepted: false } } };
    const { changed, cfg: out } = applyFolderTrust(cfg, '/wt/d');
    expect(changed).toBe(true);
    const projects = out.projects as Record<string, Record<string, unknown>>;
    expect(projects['/wt/d'].hasTrustDialogAccepted).toBe(true);
  });
});
