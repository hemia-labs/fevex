"use client";

import { useState } from 'react';

type ApprovalDecision = 'approve' | 'reject';

export function ApprovalDecisionCard({
  disabled,
  onSubmit,
  toolLabel,
}: {
  disabled?: boolean;
  onSubmit(decision: ApprovalDecision): void;
  toolLabel: string;
}) {
  const [sent, setSent] = useState<ApprovalDecision>();

  const decide = (decision: ApprovalDecision) => {
    if (disabled || sent) return;
    setSent(decision);
    onSubmit(decision);
  };

  return (
    <div className="approval-decision-card">
      <div>
        <strong>{sent ? statusText(sent) : 'Confirmar acción'}</strong>
        <p>
          {sent
            ? 'Tu respuesta fue enviada y el run continuará con esa decisión.'
            : `El agente quiere ejecutar “${toolLabel}” para continuar.`}
        </p>
      </div>
      {!sent && (
        <div className="approval-decision-actions">
          <button disabled={disabled} onClick={() => decide('reject')} type="button">
            Denegar
          </button>
          <button data-kind="approve" disabled={disabled} onClick={() => decide('approve')} type="button">
            Aprobar
          </button>
        </div>
      )}
    </div>
  );
}

function statusText(decision: ApprovalDecision) {
  return decision === 'approve' ? 'Aprobación enviada' : 'Denegación enviada';
}
