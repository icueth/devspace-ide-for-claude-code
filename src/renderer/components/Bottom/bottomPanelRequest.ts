import type { BottomPanelTab } from './BottomPanel';

export interface BottomPanelTabRequest {
  tab: BottomPanelTab;
  requestId: number;
}

export function nextBottomPanelTabRequest(
  current: BottomPanelTabRequest,
  tab: BottomPanelTab,
): BottomPanelTabRequest {
  return { tab, requestId: current.requestId + 1 };
}
