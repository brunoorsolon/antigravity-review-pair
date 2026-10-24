import { mkdtempSync, readFileSync, rmSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const temp=mkdtempSync(join(tmpdir(),'psst-pack-'));
const run=(command,args,options={})=>{const r=spawnSync(command,args,{encoding:'utf8',env:{...process.env,npm_config_cache:join(temp,'npm-cache')},...options});if(r.status!==0)throw new Error(`${command} failed: ${r.stderr}`);return r.stdout;};
try {
 const packed=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',temp]));
 const entries=packed[0].files.map(x=>x.path);
 for(const path of ['bin/psst-antigravity.mjs','src/connector.mjs','vendor/psst/reference/inbox.mjs','vendor/psst/LICENSE'])assert(entries.includes(path));
 assert(!entries.some(x=>/node_modules|test\/|\.sqlite|connection\.json|(^|\/)token$|\.github/.test(x)));
 const install=join(temp,'isolated');
 run('npm',['install','--ignore-scripts','--offline','--no-audit','--no-fund','--prefix',install,join(temp,packed[0].filename)]);
 const executable=join(install,'node_modules','antigravity-broker-connector','bin','psst-antigravity.mjs');
 assert.match(run(process.execPath,[executable,'--help'],{cwd:temp}),/cooperative stdio MCP/);
 console.log('Packed install and executable smoke passed with no sibling broker checkout.');
} finally {rmSync(temp,{recursive:true,force:true});}
