import { useEffect, useRef, useState } from 'react';
import type { DiscoveryResult } from '../shared/types';

let saved: DiscoveryResult | null = null;

/** Render the last catalog immediately; a quiet check publishes only actual changes. */
export function useDiscovery(connectionKey?: string) {
  const [result, setResult] = useState<DiscoveryResult | null>(saved);
  const [scanning, setScanning] = useState(false);
  const [checked, setChecked] = useState(Boolean(saved));
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const version = useRef(0);
  const latest = useRef(result);
  const apply = (found: DiscoveryResult, reportFailure: boolean) => {
    const previous = latest.current;
    if (reportFailure && previous) {
      const missing = previous.connections.filter(connection => previous.models.some(model => model.connectionId === connection.id) && !found.connections.some(item => item.id === connection.id));
      setError(missing.length ? `Could not reach ${missing.map(item => item.label).join(', ')}. Check the connection, then refresh models.` : found.diagnostics.find(item => item.startsWith('Model check failed.')) ?? '');
    }
    latest.current = found; saved = found;
    setResult(current => JSON.stringify(current) === JSON.stringify(found) ? current : found);
    setChecked(true);
  };
  useEffect(() => {
    mounted.current = true;
    const currentVersion = ++version.current;
    let received = false;
    const unsubscribe = window.desktop.onDiscovery(found => { received = true; if (mounted.current) apply(found, true); });
    void window.desktop.cachedDiscovery().then(cached => {
      if (!mounted.current || received || version.current !== currentVersion) return;
      if (cached) apply(cached, false);
    }).catch(error => { if (mounted.current && version.current === currentVersion) { setError(String(error)); setChecked(true); } });
    return () => { mounted.current = false; unsubscribe(); };
  }, [connectionKey]);
  const refresh = async (force = true) => {
    setScanning(true); setError('');
    try { const found = await window.desktop.autoDiscover(force); if (mounted.current) apply(found, true); }
    catch (error) { if (mounted.current) setError(String(error)); }
    finally { if (mounted.current) { setScanning(false); setChecked(true); } }
  };
  const update = (found: DiscoveryResult) => apply(found, false);
  return { result, scanning, checked, error, refresh, update };
}
