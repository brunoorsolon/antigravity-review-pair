import { readFileSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

export function readConfig(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 16384 || process.getuid && stat.uid !== process.getuid()) throw new Error('private_configuration_required');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const allowed = ['referenceRoot', 'stateRoot', 'brokerUrl', 'tokenFile', 'caFile', 'insecureDevelopment', 'name', 'project', 'binary', 'binarySha256', 'harnessVersion', 'model', 'experimentalManaged', 'nativeMcp', 'workspaceDirectory'];
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !allowed.includes(key))) throw new Error('invalid_configuration');
  for (const key of ['referenceRoot', 'stateRoot', 'tokenFile', 'binary']) if (typeof config[key] !== 'string' || !isAbsolute(config[key])) throw new Error('absolute_path_required');
  if (config.caFile !== undefined && !isAbsolute(config.caFile)) throw new Error('absolute_path_required');
  if (typeof config.name !== 'string' || !config.name || config.name.length > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(config.name)) throw new Error('invalid_name');
  if (config.project !== undefined && config.project !== null && (typeof config.project !== 'string' || config.project.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(config.project))) throw new Error('invalid_project');
  if (typeof config.brokerUrl !== 'string' || typeof config.harnessVersion !== 'string' || !/^[A-Za-z0-9._+-]{1,64}$/.test(config.harnessVersion)) throw new Error('configured_version_required');
  if (!/^[a-f0-9]{64}$/.test(config.binarySha256)) throw new Error('binary_digest_required');
  for (const key of ['experimentalManaged', 'insecureDevelopment', 'nativeMcp']) if (config[key] !== undefined && typeof config[key] !== 'boolean') throw new Error('invalid_boolean');
  if (config.nativeMcp === true && (typeof config.workspaceDirectory !== 'string' || !isAbsolute(config.workspaceDirectory) || !lstatSync(config.workspaceDirectory).isDirectory())) throw new Error('explicit_workspace_required');
  if (config.workspaceDirectory !== undefined && config.nativeMcp !== true) throw new Error('native_mcp_not_enabled');
  const binary = lstatSync(config.binary);
  if (!binary.isFile() || binary.isSymbolicLink() || binary.size > 512 * 1024 * 1024 || !(binary.mode & 0o111)) throw new Error('regular_executable_required');
  if (createHash('sha256').update(readFileSync(config.binary)).digest('hex') !== config.binarySha256) throw new Error('binary_digest_mismatch');
  mkdirSync(config.stateRoot, { recursive: true, mode: 0o700 });
  const root = lstatSync(config.stateRoot);
  if (!root.isDirectory() || root.isSymbolicLink() || root.mode & 0o077 || realpathSync(config.stateRoot) !== config.stateRoot || process.getuid && root.uid !== process.getuid()) throw new Error('private_state_directory_required');
  return config;
}
