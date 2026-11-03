import path from 'node:path';

/** Local project work must not borrow the desktop user's Git/GitHub identity. */
export function mercuryGitEnvironment(base: NodeJS.ProcessEnv, identityRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (/^(?:GIT_|GCM_|GH_|GITHUB_|SSH_AUTH_SOCK$|SSH_AGENT_PID$)/i.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    GIT_AUTHOR_NAME: 'Mercury AI',
    GIT_AUTHOR_EMAIL: 'ai@mercury.local',
    GIT_COMMITTER_NAME: 'Mercury AI',
    GIT_COMMITTER_EMAIL: 'ai@mercury.local',
    GIT_CONFIG_GLOBAL: path.join(identityRoot, 'gitconfig'),
    GIT_CONFIG_SYSTEM: path.join(identityRoot, 'gitconfig-system'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GH_CONFIG_DIR: path.join(identityRoot, 'gh'),
    // This allowlist also overrides repository-level protocol configuration.
    // Safety history is local; publishing needs a separately connected account.
    GIT_ALLOW_PROTOCOL: '',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'core.askPass',
    GIT_CONFIG_VALUE_1: '',
    GIT_CONFIG_KEY_2: 'core.hooksPath',
    GIT_CONFIG_VALUE_2: '',
  };
}

/** Direct ordinary Git commands to Mercury's private local history, never the project's .git. */
export function mercuryProjectGitEnvironment(base: NodeJS.ProcessEnv, workspaceRoot: string, identityRoot = path.join(workspaceRoot, '.mercury', 'identity')): NodeJS.ProcessEnv {
  const root = path.resolve(workspaceRoot);
  const gitDirectory = path.join(root, '.mercury', 'git');
  return {
    ...mercuryGitEnvironment(base, path.resolve(identityRoot)),
    GIT_DIR: gitDirectory,
    GIT_WORK_TREE: root,
    GIT_INDEX_FILE: path.join(gitDirectory, 'index'),
    GIT_OPTIONAL_LOCKS: '0',
  };
}
