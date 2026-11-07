/**
 * Cancel one queued (not started) job: the one path for the Cancel button and the session-command stop
 * (pstack audit 2026-10-25). Before this, cancel deleted the job's channel key and never redrew that channel's
 * ⏳ Queue board, so the cancelled row stayed until the next event; it also left per-job map entries behind
 * (a stale transient-thread entry kept that thread from being archived).
 */
export interface CancelDeps {
  /** Remove the job from the queue; false when it is not queued (running or finished). */
  cancel: (id: number) => boolean;
  /** job id → channel id (read before the job's entries are deleted). */
  jobKeys: Map<number, string>;
  /** Other per-job maps to clear (links, owner links, queued notes). */
  maps: Map<number, unknown>[];
  /** Per-job cleanup with side effects (transient thread archive timer, ⏳ reactions). */
  cleanup: (id: number) => void;
  /** Redraw the ⏳ Queue board of a channel. */
  redraw: (channelId: string) => void;
}

export function cancelQueuedJob(id: number, d: CancelDeps): boolean {
  const channelId = d.jobKeys.get(id);
  if (!d.cancel(id)) return false;
  d.jobKeys.delete(id);
  for (const m of d.maps) m.delete(id);
  d.cleanup(id);
  if (channelId) d.redraw(channelId);
  return true;
}
