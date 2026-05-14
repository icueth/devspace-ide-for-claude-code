import { describe, expect, it } from 'vitest';

import { parseSlashInput } from '@renderer/components/Dock/SlashPalette';

// v0.19 added /remember as a UI-only slash command (memory write,
// no Claude turn). These tests pin the parser shape ChatPanel relies
// on to (a) distinguish slash commands from chat prose, (b) extract
// the description that becomes the memory entry body.

describe('parseSlashInput — /remember + bare slash semantics', () => {
  it('parses /remember <text> into trigger + args verbatim', () => {
    const parsed = parseSlashInput('/remember stop using mocks in tests');
    expect(parsed).toEqual({
      trigger: 'remember',
      args: 'stop using mocks in tests',
    });
  });

  it('treats /remember with no args as the help case (empty args)', () => {
    // ChatPanel.executeSlash checks `args.trim() === ''` to surface
    // "Usage: /remember <what to save>" instead of creating an empty
    // memory entry. The parser just hands back an empty args field.
    expect(parseSlashInput('/remember')).toEqual({ trigger: 'remember', args: '' });
    expect(parseSlashInput('/remember ')).toEqual({ trigger: 'remember', args: '' });
    expect(parseSlashInput('/remember   ')).toEqual({ trigger: 'remember', args: '' });
  });

  it('returns null for plain prose (no leading slash)', () => {
    // Critical: a chat message starting with "this is /remember" must NOT
    // be intercepted. We only short-circuit when the FIRST char is '/'.
    expect(parseSlashInput('how do I /remember this')).toBeNull();
    expect(parseSlashInput('plain prose')).toBeNull();
  });

  it('preserves multi-word args without collapsing internal whitespace', () => {
    // Multi-word descriptions are the common case for /remember. The
    // parser trims surrounding whitespace but keeps internal spacing so
    // sentences read correctly when re-rendered in the memory file.
    const parsed = parseSlashInput('/remember always use rtk for builds');
    expect(parsed?.args).toBe('always use rtk for builds');
  });

  it('handles a bare slash as trigger="" so the palette shows everything', () => {
    // The slash palette filters commands by prefix-of-trigger; an empty
    // trigger means "show all". This is the /help-equivalent entry point.
    expect(parseSlashInput('/')).toEqual({ trigger: '', args: '' });
  });
});
