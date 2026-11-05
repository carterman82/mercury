import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectDiffPanel } from '../../src/renderer/ProjectDiff';

window.desktop = { projectChanges: async () => ({ baseLabel: 'Latest saved response and working changes.', truncated: false, changes: [
  { path: 'app.ts', before: 'const value = 1;', after: 'const value = 2;', binary: false },
  { path: 'image.png', before: null, after: null, binary: true },
] }) } as typeof window.desktop;
function Fixture() {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Review changes</button>{open && <ProjectDiffPanel chatId="fixture" onClose={() => setOpen(false)} />}</>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
