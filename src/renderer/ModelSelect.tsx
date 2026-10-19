import React, { useEffect, useState } from 'react';
import { modelCategory, type ModelCategory, type ModelInfo, type ModelProfile } from '../shared/types';

export function ModelSelect({ label, value, models, onChange, onOther, optional = false, disabled = false, scanning = false }: { label: string; value?: ModelProfile | null; models: ModelInfo[]; onChange: (profile?: ModelProfile) => void; onOther: () => void; optional?: boolean; disabled?: boolean; scanning?: boolean }) {
  const [category, setCategory] = useState<ModelCategory>(value ? modelCategory(value.provider) : 'local');
  useEffect(() => { if (value) setCategory(modelCategory(value.provider)); }, [value?.provider]);
  const key = (id: string | undefined, model: string) => JSON.stringify([id, model]);
  const selected = value && modelCategory(value.provider) === category ? key(value.connectionId, value.model) : '';
  const filtered = models.filter(item => modelCategory(item.provider) === category);
  const select = (model?: ModelInfo) => onChange(model ? { provider: model.provider, connectionId: model.connectionId, model: model.id, contextLimit: Math.min(model.contextLimit ?? 8192, 32768) } : undefined);
  return <div className="provider-model-select">
    <label className="field provider-field"><span className={label === 'Chat model' ? 'sr-only' : ''}>{label === 'Chat model' ? 'Model provider' : `${label} provider`}</span><select aria-label={label === 'Chat model' ? 'Model provider' : `${label} provider`} disabled={disabled} value={category} onChange={event => {
      const next = event.target.value as ModelCategory;
      setCategory(next);
      select(models.find(item => modelCategory(item.provider) === next));
    }}><option value="local">Local</option><option value="openai">OpenAI</option><option value="claude">Claude</option></select></label>
    <label className="field"><span className={label === 'Chat model' ? 'sr-only' : ''}>{label}</span><select aria-label={label} disabled={disabled} value={selected} onChange={event => {
      if (event.target.value === '__other__') { onOther(); return; }
      select(filtered.find(item => key(item.connectionId, item.id) === event.target.value));
    }}><option value="">{scanning ? 'Finding models…' : optional ? 'Use default model' : filtered.length ? 'Choose a model' : category === 'local' ? 'No local models found' : `Connect ${category === 'openai' ? 'OpenAI' : 'Claude'}…`}</option>
      {selected && value && !filtered.some(item => key(item.connectionId, item.id) === selected) && <option value={selected}>{value.model} (currently unavailable)</option>}
      {filtered.map(model => <option key={key(model.connectionId, model.id)} value={key(model.connectionId, model.id)}>{model.label} · {model.connectionLabel}{model.available ? '' : ' (not loaded)'}</option>)}
      <option value="__other__">{category === 'local' ? 'Other…' : 'Connect / manage accounts…'}</option>
    </select></label>
  </div>;
}
