import type { ReactNode } from 'react';
import Link from 'next/link';
import { ConnectionSettings } from './connection-settings';

export function StudioHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="topbar">
      <Link className="brand" href="/">
        <span className="brand-mark" aria-hidden="true">F</span>
        <span className="brand-text">
          <strong>Fevex Studio</strong>
          <small>Runs, tools y approvals</small>
        </span>
      </Link>
      <div className="topbar-actions">
        {children}
        <ConnectionSettings />
      </div>
    </header>
  );
}
