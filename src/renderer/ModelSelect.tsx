import { modelProfile } from '../shared/model-context';
import { isOpenAIAPI, prioritizeSubscriptions } from '../shared/openai-routing';
import React, { useEffect, useId, useState } from 'react';
import { modelCategory, type ModelCategory, type ModelInfo, type ModelProfile, type ModelConnection } from '../shared/types';

export function ModelSelect({ label, description, value, models, connections = [], onChange, onOther, optional = false, hideUnavailable = false, disabled = false, scanning = false }: { label: string; description?: string; value?: ModelProfile | null; models: ModelInfo[]; connections?: ModelConnection[]; onChange: (profile?: ModelProfile) => void; onOther: () => void; optional?: boolean; hideUnavailable?: boolean; disabled?: boolean; scanning?: boolean }) {
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
  const ordered = prioritizeSubscriptions(models, connections);
  const filtered = ordered.filter(item => modelCategory(item.provider) === category);
  const select = (model?: ModelInfo) => onChange(model ? modelProfile(model) : undefined);
  return <div className="provider-model-select" onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    {description && <div className="role-help"><button type="button" className="text-button" aria-label={label + ' description'} aria-expanded={helpOpen || focused} aria-controls={descriptionId} onClick={() => setHelpOpen(value => !value)} onKeyDown={event => { if (event.key === 'Escape') { setHelpOpen(false); setFocused(false); } }}>{label} ⓘ</button><p id={descriptionId} role="note" hidden={!helpOpen && !focused}>{description}</p></div>}
    <label className="field provider-field"><span className={label === 'Chat model' ? 'sr-only' : ''}>{description ? 'Provider' : label === 'Chat model' ? 'Model provider' : `${label} provider`}</span><select aria-label={label === 'Chat model' ? 'Model provider' : `${label} provider`} disabled={disabled} aria-describedby={description ? descriptionId : undefined} value={category} onChange={event => {
      const next = event.target.value as ModelCategory;
      setCategory(next);
      select(ordered.find(item => modelCategory(item.provider) === next));
    }}>{(['local', 'openai', 'claude'] as const).filter(item => !hideUnavailable || models.some(model => modelCategory(model.provider) === item)).map(item => <option key={item} value={item}>{item === 'local' ? 'Local' : item === 'openai' ? 'ChatGPT' : 'Claude'}</option>)}</select></label>
    <label className="field"><span className={label === 'Chat model' ? 'sr-only' : ''}>{description ? 'Model' : label}</span><select aria-label={label} disabled={disabled} aria-describedby={description ? descriptionId : undefined} value={selected} onChange={event => {
      if (event.target.value === '__other__') { onOther(); return; }
      select(filtered.find(item => key(item.connectionId, item.id) === event.target.value));
    }}><option value="">{scanning ? 'Finding models…' : optional ? 'Use Main model' : filtered.length ? 'Choose a model' : category === 'local' ? 'No local models found' : `Connect ${category === 'openai' ? 'ChatGPT' : 'Claude'}…`}</option>
      {selected && value && !filtered.some(item => key(item.connectionId, item.id) === selected) && <option value={selected}>{value.model} (currently unavailable)</option>}
      {category === 'local' ? [true, false].map(loaded => {
        const group = filtered.filter(model => model.available === loaded);
        return group.length ? <optgroup key={String(loaded)} label={loaded ? 'Loaded' : 'Not loaded'}>{group.map(model => <option key={key(model.connectionId, model.id)} value={key(model.connectionId, model.id)}>{model.label} · {model.connectionLabel}</option>)}</optgroup> : null;
      }) : filtered.map(model => <option key={key(model.connectionId, model.id)} value={key(model.connectionId, model.id)}>{model.label} · {model.connectionLabel}</option>)}
      <option value="__other__">{category === 'local' ? 'Other…' : 'Connect / manage accounts…'}</option>
    </select></label>
    {value?.provider === 'openai' && isOpenAIAPI(connections.find(item => item.id === value.connectionId)) && <p className="hint" role="note">Subscription first: ChatGPT or Codex is tried for this same model before the OpenAI API. If no matching subscription is available or its limit is reached, the API is used and API charges apply. A response already in progress is never switched.</p>}
  </div>;
}
