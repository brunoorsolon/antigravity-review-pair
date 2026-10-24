import { openSync, fstatSync, readFileSync, closeSync, constants, mkdirSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, dirname, resolve } from 'node:path';
import { validateMetadata } from '../vendor/psst/src/protocol.mjs';

export function readConnectorConfig(path, env = process.env) {
  let fd;
  try {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 16384 || process.getuid && stat.uid !== process.getuid()) throw new Error();
    let config = JSON.parse(readFileSync(fd, 'utf8'));
    if (config?.format === 'broker-client-bundle-v1') {
      const keys = ['format','protocol_version','broker_url','token_file','file_paths_relative_to','authorization_header','authorization_scheme','insecure_development','allowed_client_types','scope','ca_file'];
      if (Object.keys(config).some(key => !keys.includes(key)) || config.protocol_version !== '1'
        || config.file_paths_relative_to !== 'connection_file_directory' || config.authorization_header !== 'Authorization'
        || config.authorization_scheme !== 'Bearer' || config.insecure_development !== false
        || !Array.isArray(config.allowed_client_types) || !config.allowed_client_types.includes('antigravity-cli')
        || typeof config.token_file !== 'string' || !/^[A-Za-z0-9._-]+$/.test(config.token_file)
        || ['.','..'].includes(config.token_file) || typeof config.scope !== 'string') throw new Error();
      if (config.ca_file !== undefined && (typeof config.ca_file !== 'string' || !isAbsolute(config.ca_file))) throw new Error();
      config = { brokerUrl: config.broker_url, tokenFile: resolve(dirname(path), config.token_file),
        stateRoot: env.PSST_STATE_DIR ?? resolve(dirname(path), 'state'), name: env.PSST_NAME ?? 'Antigravity',
        project: env.PSST_PROJECT ?? null, ...(config.ca_file ? {caFile: config.ca_file} : {}) };
    }
    const allowed = ['brokerUrl', 'tokenFile', 'stateRoot', 'name', 'project', 'model', 'caFile', 'insecureDevelopment'];
    if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !allowed.includes(key))) throw new Error();
    for (const key of ['tokenFile', 'stateRoot']) if (typeof config[key] !== 'string' || !isAbsolute(config[key])) throw new Error();
    if (config.caFile !== undefined && (typeof config.caFile !== 'string' || !isAbsolute(config.caFile))) throw new Error();
    if (config.insecureDevelopment !== undefined && typeof config.insecureDevelopment !== 'boolean') throw new Error();
    const url = new URL(config.brokerUrl);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(config.insecureDevelopment === true && url.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(url.hostname)))) throw new Error();
    const metadata = validateMetadata({ name: config.name, project: config.project ?? null,
      model: config.model === undefined ? { provider: null, id: null, source: 'unknown' } : { provider: null, id: config.model, source: 'configured' } });
    return { ...config, metadata };
  } catch { throw new Error('invalid_connector_configuration'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function prepareStateRoot(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || realpathSync(path) !== path || process.getuid && stat.uid !== process.getuid()) throw new Error('private_state_directory_required');
}
