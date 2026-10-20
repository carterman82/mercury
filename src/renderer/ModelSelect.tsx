import React, { useEffect, useId, useState } from 'react';
import { modelCategory, type ModelCategory, type ModelInfo, type ModelProfile } from '../shared/types';

export function ModelSelect({ label, description, value, models, onChange, onOther, optional = false, hideUnavailable = false, disabled = false, scanning = false }: { label: string; description?: string; value?: ModelProfile | null; models: ModelInfo[]; onChange: (profile?: ModelProfile) => void; onOther: () => void; optional?: boolean; hideUnavailable?: boolean; disabled?: boolean; scanning?: boolean }) {
  const descriptionId = useId();
  const [helpOpen, setHelpOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [category, setCategory] = useState<ModelCategory>(value ? modelCategory(value.provider) : 'local');
  useEffect(() => { if (value) setCategory(modelCategory(value.provider)); }, [value?.provider]);
  useEffect(() => {
    if (hideUnavailable && models.length && !models.some(item => modelCategory(item.provider) === category)) setCategory(modelCategory(models[0].provider));
  }, [hideUnavailable, models, category]);
  const key = (id: string | undefined, model: string) => JSON.stringify([id, model]);
  const selected = value && modelCategory(value.provider) === category && (!hideUnavailable || models.some(item => item.connectionId === value.connectionId && item.id === value.model)) ? key(value.connectionId, value.model) : '';
  const filtered = models.filter(item => modelCategory(item.provider) === category);
  const select = (model?: ModelInfo) => onChange(model ? { provider: model.provider, connectionId: model.connectionId, model: model.id, contextLimit: Math.min(model.contextLimit ?? 8192, 32768) } : undefined);
  return <div className="provider-model-select" onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    {description && <div className="role-help"><button type="button" className="text-button" aria-label={label + ' description'} aria-expanded={helpOpen || focused} aria-controls={descriptionId} onClick={() => setHelpOpen(value => !value)} onKeyDown={event => { if (event.key === 'Escape') { setHelpOpen(false); setFocused(false); } }}>{label} ⓘ</button><p id={descriptionId} role="note" hidden={!helpOpen && !focused}>{description}</p></div>}
    <label className="field provider-field"><span className={label === 'Chat model' ? 'sr-only' : ''}>{description ? 'Provider' : label === 'Chat model' ? 'Model provider' : `${label} provider`}</span><select aria-label={label === 'Chat model' ? 'Model provider' : `${label} provider`} disabled={disabled} aria-describedby={description ? descriptionId : undefined} value={category} onChange={event => {
      const next = event.target.value as ModelCategory;
      setCategory(next);
      select(models.find(item => modelCategory(item.provider) === next));
    }}>{(['local', 'openai', 'claude', 'codex'] as const).filter(item => !hideUnavailable || models.some(model => modelCategory(model.provider) === item)).map(item => <option key={item} value={item}>{item === 'local' ? 'Local' : item === 'openai' ? 'OpenAI' : item === 'codex' ? 'Codex' : 'Claude'}</option>)}</select></label>
    <label className="field"><span className={label === 'Chat model' ? 'sr-only' : ''}>{description ? 'Model' : label}</span><select aria-label={label} disabled={disabled} aria-describedby={description ? descriptionId : undefined} value={selected} onChange={event => {
      if (event.target.value === '__other__') { onOther(); return; }
      select(filtered.find(item => key(item.connectionId, item.id) === event.target.value));
    }}><option value="">{scanning ? 'Finding models…' : optional ? 'Use Main model' : filtered.length ? 'Choose a model' : category === 'local' ? 'No local models found' : `Connect ${category === 'openai' ? 'OpenAI' : category === 'codex' ? 'Codex' : 'Claude'}…`}</option>
      {selected && value && !filtered.some(item => key(item.connectionId, item.id) === selected) && <option value={selected}>{value.model} (currently unavailable)</option>}
      {filtered.map(model => <option key={key(model.connectionId, model.id)} value={key(model.connectionId, model.id)}>{model.label} · {model.connectionLabel}{model.available ? '' : ' (not loaded)'}</option>)}
      <option value="__other__">{category === 'local' ? 'Other…' : 'Connect / manage accounts…'}</option>
    </select></label>
  </div>;
}
