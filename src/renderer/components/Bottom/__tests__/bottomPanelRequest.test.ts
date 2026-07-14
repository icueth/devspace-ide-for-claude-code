import { describe, expect, it } from 'vitest';

import { nextBottomPanelTabRequest } from '../bottomPanelRequest';

describe('bottom panel tab requests', () => {
  it('increments the request id when the same tab is requested repeatedly', () => {
    const first = nextBottomPanelTabRequest({ tab: 'terminal', requestId: 0 }, 'git');
    const second = nextBottomPanelTabRequest(first, 'git');

    expect(first).toEqual({ tab: 'git', requestId: 1 });
    expect(second).toEqual({ tab: 'git', requestId: 2 });
  });
});
