'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { shortId } from '@/lib/format';
import { apiBaseUrl } from '@/lib/studio-api';
import { ConnectionSettings } from './connection-settings';

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const runId = pathname.startsWith('/runs/') ? pathname.split('/')[2] : undefined;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="sidebar-brand" href="/">
          <span className="brand-mark" aria-hidden="true">
            F
          </span>
          <span className="brand-text">
            <strong>Fevex</strong>
            <small>Studio</small>
          </span>
        </Link>

        <nav className="sidebar-nav" aria-label="Navegación principal">
          <span className="sidebar-label">Workspace</span>
          <Link
            aria-current={runId ? undefined : 'page'}
            className={`nav-item${runId ? '' : ' active'}`}
            href="/"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M4 6h16M4 12h16M4 18h10" />
            </svg>
            Runs
          </Link>
        </nav>

        <div className="sidebar-footer">
          <span className="sidebar-label">Entorno</span>
          <p className="sidebar-env">
            <span className="env-dot" aria-hidden="true" />
            Local
          </p>
          <code>{apiBaseUrl.replace(/^https?:\/\//, '')}</code>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <Link className="mobile-brand" href="/">
            <span className="brand-mark" aria-hidden="true">
              F
            </span>
            <span>Fevex Studio</span>
          </Link>
          <div className="breadcrumb">
            <span className="breadcrumb-root">Workspace</span>
            <span className="breadcrumb-separator">/</span>
            {runId ? (
              <>
                <Link href="/">Runs</Link>
                <span className="breadcrumb-separator">/</span>
                <span className="mono">{shortId(runId)}</span>
              </>
            ) : (
              <span className="breadcrumb-current">Runs</span>
            )}
          </div>
          <div className="topbar-actions">
            <ConnectionSettings />
          </div>
        </header>

        {children}
      </div>
    </div>
  );
}
