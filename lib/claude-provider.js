'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Only routing settings may leave the user's harness config. Authentication
// stays in inherited environment variables, linked files or helper commands.
const CONFIG_ENV = /^(CLAUDE_CODE_USE_[A-Z]+|AWS_REGION|AWS_DEFAULT_REGION|AWS_PROFILE|AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE|CLOUD_ML_REGION|VERTEX_REGION_[A-Z0-9_]+|ANTHROPIC_VERTEX_PROJECT_ID|ANTHROPIC_(BEDROCK|VERTEX|FOUNDRY)_BASE_URL|ANTHROPIC_FOUNDRY_RESOURCE|ANTHROPIC_MODEL|ANTHROPIC_SMALL_FAST_MODEL(_AWS_REGION)?|ANTHROPIC_DEFAULT_[A-Z]+_MODEL)$/;
const MODELS = { opus: 'claude-opus-5-5', fable: 'claude-fable-5-1', sonnet: 'claude-sonnet-5-5' };
const selected = (rung) => rung.harness === 'claude' && ['anthropic', 'bedrock'].includes(rung.provider);

function settings(from) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(from.claude.dir, 'settings.json'), 'utf8'));
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  }
  catch { return {}; }
}

function model(provider, value) {
  const plain = String(value || '').replace(/^(?:(?:global|us|eu|apac)\.)?anthropic\./, '');
  const id = MODELS[plain] || plain;
  return provider === 'bedrock' ? `global.anthropic.${id}` : id;
}

function configEnv(doc) {
  const env = doc.env || {};
  return Object.fromEntries(Object.keys(env).filter((key) => CONFIG_ENV.test(key) && typeof env[key] === 'string').map((key) => [key, env[key]]));
}

function aws(env, from, doc) {
  const configured = configEnv(doc);
  for (const key of ['AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION']) {
    if (env[key] !== undefined) configured[key] = env[key];
  }
  const config = configured.AWS_CONFIG_FILE || path.join(from.home, '.aws', 'config');
  const credentials = configured.AWS_SHARED_CREDENTIALS_FILE || path.join(from.home, '.aws', 'credentials');
  const profile = configured.AWS_PROFILE || 'default';
  let section = '';
  let region;
  let auth = false;
  try {
    for (const line of fs.readFileSync(config, 'utf8').split(/\r?\n/)) {
      const heading = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (heading) section = heading[1].trim();
      if (section !== `profile ${profile}` && !(profile === 'default' && section === 'default')) continue;
      const setting = line.match(/^\s*([\w]+)\s*=\s*(.*)$/);
      if (!setting) continue;
      if (setting[1] === 'region') region = setting[2].trim();
      if (/^(sso_session|sso_start_url|role_arn|credential_process|web_identity_token_file)$/.test(setting[1])) auth = true;
    }
  } catch { /* An absent config may still use environment authentication. */ }
  return { configured, config: path.resolve(config), credentials: path.resolve(credentials),
    region: configured.AWS_REGION || configured.AWS_DEFAULT_REGION || region, auth };
}

function problems(rung, env, from, launch = {}) {
  if (!selected(rung)) return [];
  // Only the real launcher reads env_file values. Its read and parse errors
  // remain launch failures rather than guessing which credentials it holds.
  if (launch.env_file) return [];
  const names = new Set([...Object.keys(env), ...Object.keys(launch.env || {})]);
  const present = (name) => names.has(name);
  const routing = { ...configEnv({ env }), ...configEnv({ env: launch.env }) };
  const doc = settings(from);
  if (rung.provider === 'anthropic') {
    const ready = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].some(present)
      || typeof doc.apiKeyHelper === 'string' || fs.existsSync(path.join(from.claude.dir, '.credentials.json'));
    return ready ? [] : ['anthropic credentials missing: configure an API key, Claude login or apiKeyHelper in your own harness'];
  }
  const a = aws(routing, from, doc);
  const ready = present('AWS_BEARER_TOKEN_BEDROCK')
    || present('AWS_ACCESS_KEY_ID') && present('AWS_SECRET_ACCESS_KEY')
    || present('AWS_WEB_IDENTITY_TOKEN_FILE') && present('AWS_ROLE_ARN')
    || ['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI'].some(present)
    || ['awsAuthRefresh', 'awsCredentialExport'].some((key) => typeof doc[key] === 'string')
    || a.auth || fs.existsSync(a.credentials);
  return [
    ...(!a.region ? ['bedrock region missing: configure AWS_REGION, AWS_DEFAULT_REGION or your AWS profile region'] : []),
    ...(!ready ? ['bedrock credentials missing: configure AWS authentication in your own harness'] : []),
  ];
}

function environment(rung, env, from, doc = settings(from), launch = {}) {
  if (!selected(rung)) return {};
  const out = {
    CLAUDE_CODE_USE_BEDROCK: rung.provider === 'bedrock' ? '1' : '0',
    CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
    ANTHROPIC_MODEL: model(rung.provider, rung.model),
  };
  const routing = { ...configEnv({ env }), ...configEnv({ env: launch.env }) };
  const inherited = { ...configEnv(doc), ...routing };
  for (const [key, value] of Object.entries(inherited)) {
    if (/^ANTHROPIC_(DEFAULT_[A-Z]+|SMALL_FAST)_MODEL$/.test(key)) out[key] = model(rung.provider, value);
  }
  for (const [alias, id] of Object.entries(MODELS)) out[`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`] = model(rung.provider, id);
  if (rung.provider === 'bedrock') {
    const a = aws(routing, from, doc);
    // A file may select another profile whose region the AWS SDK resolves.
    const region = launch.env_file ? a.configured.AWS_REGION || a.configured.AWS_DEFAULT_REGION : a.region;
    if (region) out.AWS_REGION = region;
    if (a.configured.AWS_PROFILE) out.AWS_PROFILE = a.configured.AWS_PROFILE;
    // Isolated agent homes must still resolve the user's AWS files.
    out.AWS_CONFIG_FILE = a.config;
    out.AWS_SHARED_CREDENTIALS_FILE = a.credentials;
  }
  return out;
}

module.exports = { selected, model, configEnv, problems, environment };
