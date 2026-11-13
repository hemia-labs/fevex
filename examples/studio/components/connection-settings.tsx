'use client';

import { useEffect, useState } from 'react';
import { apiBaseUrl, saveToken, storedToken } from '@/lib/studio-api';

export function ConnectionSettings() {
  const [token, setToken] = useState('');

  useEffect(() => {
    setToken(storedToken() ?? '');
  }, []);

  return (
    <details className="settings">
      <summary>Conexión</summary>
      <div className="settings-panel">
        <p>
          API <code>{apiBaseUrl}</code>
        </p>
        <label>
          Bearer token
          <input
            autoComplete="off"
            onChange={(change) => setToken(change.target.value)}
            placeholder="opcional en modo demo"
            type="password"
            value={token}
          />
        </label>
        <p className="muted">
          El playground usa <code>FEVEX_DEMO_AUTH=1</code>; el token solo hace
          falta cuando la API exige autenticación.
        </p>
        <button
          className="button button-primary"
          onClick={() => {
            saveToken(token);
            window.location.reload();
          }}
          type="button"
        >
          Guardar y recargar
        </button>
      </div>
    </details>
  );
}
