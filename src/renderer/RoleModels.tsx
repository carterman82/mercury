import React from 'react';
import { ModelSelect } from './ModelSelect';
import { contextLimitDetails } from '../shared/cloud-context';
import { modelProfile } from '../shared/model-context';
import { isLocalModel, sameModel } from '../shared/agent-pools';
import type { ModelConnection, ModelInfo, ModelProfile } from '../shared/types';

export function RoleModels({ label, description, value, extras = [], models, connections, optional, onChange, onOther }: {
  label: string; description: string; value: ModelProfile | null; extras?: ModelProfile[];
  models: ModelInfo[]; connections: ModelConnection[]; optional: boolean;
  onChange: (value: ModelProfile | null, extras: ModelProfile[]) => void; onOther: () => void;
}) {
  const pool = [value, ...(value && isLocalModel(value) ? extras : [])];
  const pooled = label !== 'Planner model' && value && isLocalModel(value);
  const change = (index: number, profile: ModelProfile | null) => {
    if (index === 0) { onChange(profile, profile && isLocalModel(profile) ? extras : []); return; }
    onChange(value, extras.map((item, offset) => offset === index - 1 ? profile! : item));
  };
  const move = (index: number, direction: number) => {
    const next = [...pool] as ModelProfile[];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    onChange(next[0], next.slice(1));
  };
  const available = models.filter(item => (item.provider === 'lmstudio' || item.provider === 'ollama') && !pool.some(profile => profile && sameModel(profile, { provider: item.provider, model: item.id, connectionId: item.connectionId, contextLimit: 2048 })));
  return <div className="model-role" aria-label={`${label} pool`}>
    {pool.map((profile, index) => {
      const rowLabel = index ? `${label} ${index + 1}` : label;
      const selected = models.find(model => model.provider === profile?.provider && model.connectionId === profile?.connectionId && model.id === profile?.model);
      const context = contextLimitDetails(selected);
      return <div className="agent-pool-row" key={index}>
        {pooled && pool.length > 1 && <div className="agent-pool-order"><span>Priority {index + 1}</span>
          <button className="ghost" aria-label={`Move ${rowLabel} up`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
          <button className="ghost" aria-label={`Move ${rowLabel} down`} disabled={index === pool.length - 1} onClick={() => move(index, 1)}>↓</button>
          <button className="ghost" aria-label={`Remove ${rowLabel}`} onClick={() => { const next = pool.filter((_, offset) => offset !== index) as ModelProfile[]; onChange(next[0] ?? null, next.slice(1)); }}>Remove</button>
        </div>}
        <ModelSelect hideUnavailable label={rowLabel} description={index ? undefined : description} value={profile} models={index ? models.filter(item => item.provider === 'lmstudio' || item.provider === 'ollama') : models} connections={connections} onOther={onOther} optional={optional && index === 0} onChange={next => { if (index && !next) { onChange(value, extras.filter((_, offset) => offset !== index - 1)); } else change(index, next ?? null); }} />
        {profile && selected && <><label className="field compact"><span>Context limit · {rowLabel}</span><input type="number" min={2048} max={context?.tokens} aria-describedby={`context-source-${rowLabel}`} value={profile.contextLimit} onChange={event => change(index, { ...profile, contextLimit: Number(event.target.value), contextMode: 'manual' })} /></label>
          <p className="hint" id={`context-source-${rowLabel}`}>{context?.source === 'published' ? `Published model limit · ${context.tokens.toLocaleString()} tokens · Verified ${context.verifiedAt}. Your account may have a lower limit.` : context ? `Reported by connection · ${context.tokens.toLocaleString()} tokens` : 'Maximum unknown. Set a working limit for this model.'}</p>
          {context && profile.contextMode === 'manual' && <button className="text-button" aria-label={`Use model maximum · ${rowLabel}`} onClick={() => change(index, { ...profile, contextLimit: context.tokens, contextMode: 'auto' })}>Use model maximum</button>}
        </>}
      </div>;
    })}
    {pooled && <><button className="agent-pool-add" aria-label={`Add ${label.toLowerCase()} to pool`} disabled={pool.length >= 32} onClick={() => { const next = available.find(item => item.available) ?? available[0]; if (next) onChange(value, [...extras, modelProfile(next)]); else onOther(); }}><span aria-hidden="true">＋</span> Add model / device</button>
      <p className="hint">Higher models are picked first when capacity is available.{label === 'Subagent model' ? ' Subagents first prefer a different device from Main and other busy subagents.' : ' Chats using the Main pool use the next model when earlier models are busy.'} Adding a model on another device increases capacity; duplicate entries share the same server limit.</p></>}
  </div>;
}
