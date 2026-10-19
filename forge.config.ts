import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { VitePlugin } from '@electron-forge/plugin-vite';

const config: ForgeConfig = {
  buildIdentifier: () => process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '',
  packagerConfig: { asar: true, name: 'Mercury' },
  makers: [new MakerSquirrel({})],
  plugins: [new VitePlugin({
    build: [
      { entry: 'src/main/main.ts', config: 'vite.main.config.ts' },
      { entry: 'src/main/preload.ts', config: 'vite.preload.config.ts' },
    ],
    renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
  })],
};

export default config;
