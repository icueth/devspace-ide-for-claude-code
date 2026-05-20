import { describe, expect, it } from 'vitest';

import { buildCapturePanesArgs, parseCapturedPanes } from '@main/ipc/tmux';

describe('tmux batch capture (v0.27 N+1 fix)', () => {
  const DELIM = '__DEVSPACE_CAP_test__';

  it('builds one chained tmux invocation for N panes', () => {
    const args = buildCapturePanesArgs(['%1', '%2'], 3, DELIM);
    expect(args).toEqual([
      'capture-pane', '-p', '-t', '%1', '-S', '-3',
      ';', 'display-message', '-p', DELIM,
      ';',
      'capture-pane', '-p', '-t', '%2', '-S', '-3',
      ';', 'display-message', '-p', DELIM,
    ]);
  });

  it('parses delimiter-separated output back to per-pane content', () => {
    const raw = `tab one line a\ntab one line b\n${DELIM}\ntab two line a\n${DELIM}\n`;
    const out = parseCapturedPanes(raw, ['%1', '%2'], DELIM);
    expect(out['%1']).toBe('tab one line a\ntab one line b');
    expect(out['%2']).toBe('tab two line a');
  });

  it('maps exactly the requested panes even with a trailing delimiter segment', () => {
    const raw = `a\n${DELIM}\nb\n${DELIM}\nc\n${DELIM}\n`;
    const out = parseCapturedPanes(raw, ['%1', '%2', '%3'], DELIM);
    expect(Object.keys(out)).toEqual(['%1', '%2', '%3']);
    expect(out['%3']).toBe('c');
  });

  it('yields empty strings for panes with no captured output', () => {
    const raw = `${DELIM}\n${DELIM}\n`;
    const out = parseCapturedPanes(raw, ['%1', '%2'], DELIM);
    expect(out['%1']).toBe('');
    expect(out['%2']).toBe('');
  });
});
