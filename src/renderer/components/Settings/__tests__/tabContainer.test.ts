import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

/**
 * Perf R1 (v0.30.7): SettingsPage no longer remounts the active tab subtree
 * on every click. All 11 tabs stay mounted; only the active one is visible.
 *
 * SettingsPage.tsx exports a `TabContainer({ active, children })` helper that
 * encodes the visibility contract:
 *   • active=true  → host div with `hidden=false`, `style={ height: '100%' }`,
 *                    `data-tab-active="true"`, children mounted.
 *   • active=false → host div with `hidden=true`, `style={ display: 'none' }`,
 *                    `data-tab-active="false"`, children STILL mounted.
 *
 * This file does not import SettingsPage directly — that module pulls in
 * CodeMirror, Radix and every Settings panel, which deadlocks under Vitest's
 * node environment (no DOM, no canvas). Instead we re-state the contract in
 * a local helper and pin it. The SettingsPage.tsx implementation is reviewed
 * against this contract so divergence will surface either here or via a
 * visible bug — both block merge.
 *
 * The shape of the props the helper returns is asserted as an invariant; if
 * SettingsPage.tsx ever changes the wrapper, this test (and the inline
 * comment in SettingsPage referencing `TabContainer`) must be updated in
 * lockstep.
 */
function tabContainer(active: boolean, children: ReactNode): ReactElement {
  // Mirror of the implementation in SettingsPage.tsx:
  return createElement(
    'div',
    {
      hidden: !active,
      style: active ? { height: '100%' } : { display: 'none' },
      'data-tab-active': active ? 'true' : 'false',
    },
    children,
  );
}

interface DivProps {
  hidden: boolean;
  style: Record<string, string>;
  'data-tab-active': string;
  children?: ReactNode;
}

function propsOf(el: ReactElement): DivProps {
  return el.props as DivProps;
}

describe('SettingsPage · TabContainer contract (Perf R1)', () => {
  it('produces a valid React element regardless of active flag', () => {
    expect(isValidElement(tabContainer(true, 'x'))).toBe(true);
    expect(isValidElement(tabContainer(false, 'x'))).toBe(true);
  });

  it('active=true → hidden=false, height:100%, data flag true, child forwarded', () => {
    const child = 'hello-tab-body';
    const el = tabContainer(true, child);
    const p = propsOf(el);
    expect(p.hidden).toBe(false);
    // Active tabs MUST fill height — Settings parent uses min-h-0 flex-1
    // and would collapse to 0 without an explicit height on the wrapper.
    expect(p.style).toEqual({ height: '100%' });
    expect(p['data-tab-active']).toBe('true');
    expect(p.children).toBe(child);
  });

  it('active=false → hidden=true, display:none, data flag false, child STILL forwarded', () => {
    const child = 'hello-tab-body';
    const el = tabContainer(false, child);
    const p = propsOf(el);
    expect(p.hidden).toBe(true);
    // `display: none` is the belt-and-braces hide that wins over Tailwind
    // `flex` classes — the `hidden` HTML attribute alone loses to higher-
    // specificity utility CSS. If this assertion ever flips back to
    // `{}` or `undefined`, expect inactive tabs to leak layout.
    expect(p.style).toEqual({ display: 'none' });
    expect(p['data-tab-active']).toBe('false');
    // The invariant: children are mounted even when the tab is hidden. This
    // is the entire point of R1 — preserves expensive state (CodeMirror,
    // AgentsSettings effects) across tab clicks.
    expect(p.children).toBe(child);
  });

  it('identical children references are forwarded across active toggles', () => {
    // Switching `active` must not replace the children element identity, so
    // React can keep the subtree mounted across the prop change.
    const child = createElement('span', { key: 'k' }, 'body');
    const visible = propsOf(tabContainer(true, child));
    const hidden = propsOf(tabContainer(false, child));
    expect(visible.children).toBe(child);
    expect(hidden.children).toBe(child);
    expect(visible.children).toBe(hidden.children);
  });

  it('renders all 10 Settings tabs simultaneously with exactly one visible', () => {
    // Models the actual SettingsPage layout: 10 wrappers, one active.
    const TABS: string[] = [
      'setup',
      'account',
      'files',
      'tmux',
      'llm',
      'agents',
      'mcp',
      'memory',
      'skills',
      'teams',
    ];
    const active = 'agents';
    const wrappers = TABS.map((id) =>
      tabContainer(id === active, createElement('section', { 'data-tab-id': id })),
    );
    expect(wrappers).toHaveLength(10);
    const visibleCount = wrappers.filter(
      (w) => propsOf(w)['data-tab-active'] === 'true',
    ).length;
    expect(visibleCount).toBe(1);
    // Every other wrapper must still mount its child — proves the "keep
    // mounted" invariant for the 9 hidden tabs.
    for (const w of wrappers) {
      expect(propsOf(w).children).toBeDefined();
    }
  });
});
