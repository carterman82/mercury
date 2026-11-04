import { useEffect, useState } from 'react';
import type { PluginConfigurationCandidate } from '../shared/types';

/** Credentials cross only the trusted desktop bridge, never the model/chat. */
export function PluginSetup() {
  const [candidates, setCandidates] = useState<PluginConfigurationCandidate[]>([]);
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const refresh = async () => setCandidates(await window.desktop.pluginConfigurationCandidates());
  useEffect(() => { void refresh().catch(error => setError(String(error))); }, []);
  return <section aria-label="MCP connection setup"><h3>MCP connection setup</h3>
    <p>Discover a plugin in chat first. Enter its required connection headers here; credentials are encrypted on this computer and kept out of chat.</p>
    <button type="button" disabled={saving} onClick={() => void refresh().catch(error => setError(String(error)))}>Refresh discovered plugins</button>
    {error && <p role="alert">{error}</p>}
    {candidates.map(candidate => <form key={candidate.candidateId} onSubmit={event => {
      event.preventDefault(); setSaving(true); setError('');
      void window.desktop.configurePlugin(candidate.candidateId, values[candidate.candidateId] ?? {}).then(async () => {
        setValues(current => { const next = { ...current }; delete next[candidate.candidateId]; return next; });
        await refresh();
      }).catch(error => setError(String(error))).finally(() => setSaving(false));
    }}><h4>{candidate.name}</h4><p>{candidate.url}</p>
      {candidate.headers.map(header => <label className="field" key={header}><span>{header}</span><input type="password" autoComplete="off" required disabled={saving} value={values[candidate.candidateId]?.[header] ?? ''} onChange={event => {
        const value = event.target.value;
        setValues(current => ({ ...current, [candidate.candidateId]: { ...current[candidate.candidateId], [header]: value } }));
      }} /></label>)}
      <button type="submit" disabled={saving}>Save connection credentials</button>
      {candidate.configured && <p>Credentials saved. Return to chat to install or use this plugin; installation and tool approvals still apply.</p>}
    </form>)}
  </section>;
}
