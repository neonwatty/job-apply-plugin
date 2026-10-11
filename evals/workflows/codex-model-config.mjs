import { join } from 'node:path';

export const codexProposalModel = 'gpt-6.1-sol';
export const disabledCodexFeatures = Object.freeze(['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use',
  'browser_use_external', 'computer_use', 'in_app_browser', 'image_generation', 'multi_agent', 'multi_agent_v2',
  'goals', 'sleep_tool', 'hooks', 'memories', 'code_mode', 'code_mode_host', 'skill_search', 'tool_suggest',
  'workspace_dependencies', 'view_image', 'enable_request_compression']);

export function codexProposalArguments(root, probePort) {
  const args = ['--no-daemon', 'exec', '--strict-config', '--ignore-user-config', '--ignore-rules', '--ephemeral',
    '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--output-schema', join(root, 'proposal-schema.json'),
    '-C', join(root, 'work'), '-m', codexProposalModel];
  const config = ['approval_policy="never"', 'web_search="disabled"', 'project_doc_max_bytes=0',
    `model_catalog_json=${JSON.stringify(join(root, 'catalog.json'))}`, 'features.skip_host_skill_discovery=true',
    ...disabledCodexFeatures.map(feature => `features.${feature}=false`)];
  if (probePort !== undefined) {
    if (!Number.isSafeInteger(probePort) || probePort < 1 || probePort > 65535) throw Error('codex_probe_invalid_port');
    config.push('model_provider="workflow_probe"', 'model_providers.workflow_probe.name="Workflow wire probe"',
      `model_providers.workflow_probe.base_url="http://127.0.0.1:${probePort}/v1"`,
      'model_providers.workflow_probe.wire_api="responses"', 'model_providers.workflow_probe.requires_openai_auth=false',
      'model_providers.workflow_probe.supports_websockets=false', 'model_providers.workflow_probe.request_max_retries=0',
      'model_providers.workflow_probe.stream_max_retries=0');
  } else config.push('model_provider="openai"');
  for (const item of config) args.push('-c', item);
  return [...args, '-'];
}

export function codexProposalEnvironment(root, authHome = join(root, 'codex')) {
  // Auth stays inside Codex's normal credential handling. No token is read or copied by this harness.
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, CODEX_HOME: authHome, TMPDIR: root,
    NO_COLOR: '1', TERM: 'dumb' };
}
