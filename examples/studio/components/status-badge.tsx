import type { RunRecord } from '@fevex/core';
import { runStatusTone, statusLabel } from '@/lib/format';

export function StatusBadge({ status }: { status: RunRecord['status'] }) {
  return (
    <span className={`badge tone-${runStatusTone(status)}`}>
      <span className="badge-dot" aria-hidden="true" />
      {statusLabel(status)}
    </span>
  );
}
