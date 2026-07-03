export const CHAT_SCROLL_BOTTOM_THRESHOLD = 32;

type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

export function isNearScrollBottom(metrics: ScrollMetrics, threshold = CHAT_SCROLL_BOTTOM_THRESHOLD): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}
