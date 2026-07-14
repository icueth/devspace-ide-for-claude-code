import { describe, expect, it } from 'vitest';

import {
  selectOrphans,
  tmuxNameToKey,
  type CliTmuxSession,
} from '../sessionReconcile';

describe('tmuxNameToKey', () => {
  it('maps a cli tab session name to its PtyPool key', () => {
    expect(tmuxNameToKey('devspace-cli-abc123-w220m4', 'devspace')).toBe(
      'abc123:claude-cli:w220m4',
    );
  });
  it('maps a default-tab name', () => {
    expect(tmuxNameToKey('devspace-cli-abc123', 'devspace')).toBe(
      'abc123:claude-cli:default',
    );
  });
  it('maps a task agent name', () => {
    expect(tmuxNameToKey('devspace-cli-k9qxhz-agent', 'devspace')).toBe(
      'k9qxhz:claude-cli:agent',
    );
  });
  it('maps every supported non-Claude CLI prefix', () => {
    expect(tmuxNameToKey('devspace-oc-p1-tab1', 'devspace')).toBe(
      'p1:opencode-cli:tab1',
    );
    expect(tmuxNameToKey('devspace-cx-p1-tab1', 'devspace')).toBe(
      'p1:codex-cli:tab1',
    );
    expect(tmuxNameToKey('devspace-gm-p1-tab1', 'devspace')).toBe(
      'p1:gemini-cli:tab1',
    );
    expect(tmuxNameToKey('devspace-ag-p1-tab1', 'devspace')).toBe(
      'p1:antigravity-cli:tab1',
    );
  });
  // Agent Flow tab ids contain dashes (`flow-<runId>-<nodeId>`). Splitting on
  // the LAST dash would derive `…-flow-r1:claude-cli:coder` — a key that matches
  // no protected session, so boot reconcile would kill a live flow agent.
  it('maps an Agent Flow session name whose tab id contains dashes', () => {
    expect(tmuxNameToKey('devspace-cli-abc123-flow-r1-coder', 'devspace')).toBe(
      'abc123:claude-cli:flow-r1-coder',
    );
    expect(tmuxNameToKey('devspace-cx-abc123-flow-r1-tester', 'devspace')).toBe(
      'abc123:codex-cli:flow-r1-tester',
    );
  });

  it('returns null for non-cli sessions (shells, chat-runs)', () => {
    expect(tmuxNameToKey('devspace-shell-abc123', 'devspace')).toBeNull();
    expect(tmuxNameToKey('devspace-chatrun-xyz', 'devspace')).toBeNull();
  });
});

const S = (name: string, key: string, attached: boolean): CliTmuxSession => ({
  name,
  key,
  attached,
});

describe('selectOrphans', () => {
  it('keeps attached / open-tab / task sessions and kills only the rest', () => {
    const sessions = [
      S('devspace-cli-p-open', 'p:claude-cli:open', false), // open tab → keep
      S('devspace-cli-p-vis', 'p:claude-cli:vis', true), // attached → keep
      S('devspace-cli-t-agent', 't:claude-cli:agent', false), // task → keep
      S('devspace-cli-old-x', 'old:claude-cli:x', false), // orphan → KILL
      S('devspace-cli-old-y', 'old:claude-cli:y', false), // orphan → KILL
    ];
    const live = new Set(['p:claude-cli:open']);
    const tasks = new Set(['t:claude-cli:agent']);
    expect(selectOrphans(sessions, live, tasks).sort()).toEqual([
      'devspace-cli-old-x',
      'devspace-cli-old-y',
    ]);
  });

  it('never kills an attached session even if not live or task', () => {
    const sessions = [S('devspace-cli-a-b', 'a:claude-cli:b', true)];
    expect(selectOrphans(sessions, new Set(), new Set())).toEqual([]);
  });

  it('kills nothing when every detached session is accounted for', () => {
    const sessions = [S('devspace-cli-a-b', 'a:claude-cli:b', false)];
    expect(selectOrphans(sessions, new Set(['a:claude-cli:b']), new Set())).toEqual(
      [],
    );
  });
});
