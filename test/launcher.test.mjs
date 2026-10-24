import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { httpFixture, registration, sendBody } from '../../ai-agent-msg-broker/test/helpers.mjs';

for (const nativeMcp of [false, true]) test(`launcher owns a synthetic native process with MCP ${nativeMcp}: serial input, no action-success inference`, { timeout: 20000 }, async t => {
  const broker = await httpFixture(t), sender = registration('pi');
  await broker.request('/v1/sessions', { method: 'POST', body: sender });
  const directory = mkdtempSync(join(tmpdir(), 'agy-launch-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fake = join(directory, 'fake-agy.mjs'), token = join(directory, 'token'), config = join(directory, 'config.json');
  const source = `#!${process.execPath}\nimport{createInterface}from'node:readline';import{setTimeout as delay}from'node:timers/promises';import{readFileSync,existsSync}from'node:fs';import{spawn}from'node:child_process';
const output=o=>console.log(JSON.stringify(o));let busy=false,turn=0;output({event:'init',conversation_id:'synthetic-owned-id',init:{permission_mode:'request-review'}});
let mcp,ask;const configPath='.agents/mcp_config.json';if(existsSync(configPath)){const c=JSON.parse(readFileSync(configPath)).mcpServers.lan_broker;mcp=spawn(c.command,c.args,{stdio:['pipe','pipe','pipe']});let buffer='',id=0;const pending=new Map();mcp.stdout.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\\n')){const n=buffer.indexOf('\\n'),frame=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);pending.get(frame.id)?.(frame);pending.delete(frame.id)}});mcp.stderr.resume();ask=(method,params)=>new Promise(resolve=>{const key=++id;pending.set(key,resolve);mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method,params})+'\\n')});await ask('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'synthetic-agy',version:'0.0.0'}});mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\\n')}
const input=createInterface({input:process.stdin});for await(const line of input){if(busy)throw Error('parallel input');busy=true;const frame=JSON.parse(line);if(frame.event!=='user')throw Error('not user');if(ask){const hook=JSON.parse(readFileSync('.agents/hooks.json'))['lan-broker-exact-session'].PreToolUse[0].hooks[0];const h=spawn('/bin/sh',['-c',hook.command],{stdio:['pipe','pipe','pipe']});let gate='';h.stdout.on('data',c=>gate+=c);h.stdin.end(JSON.stringify({conversationId:'synthetic-owned-id',toolCall:{name:'broker_list_clients'}}));await new Promise(r=>h.once('exit',r));if(JSON.parse(gate).decision!=='allow')throw Error('native hook denied root');const listing=await ask('tools/call',{name:'broker_list_clients',arguments:{}});if(!JSON.parse(listing.result.content[0].text).clients)throw Error('native MCP unavailable')}await delay(100);output({event:'result',result:{conversation_id:'synthetic-owned-id',status:'SUCCESS',num_turns:++turn,response:frame.message.content}});busy=false}
`;
  writeFileSync(fake, source, { mode: 0o700 }); writeFileSync(token, broker.b.token, { mode: 0o600 });
  writeFileSync(config, JSON.stringify({ referenceRoot: process.env.BROKER_REFERENCE_DIR ?? resolve('../ai-agent-msg-broker'), stateRoot: directory,
    brokerUrl: broker.base, tokenFile: token, insecureDevelopment: true, name: 'same-name', binary: fake,
    binarySha256: createHash('sha256').update(source).digest('hex'), harnessVersion: '0.0.0-synthetic', experimentalManaged: true, ...(nativeMcp ? { nativeMcp: true, workspaceDirectory: directory } : {}) }), { mode: 0o600 });
  const child = spawn(process.execPath, ['bin/launch.mjs', config], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let output = '', errors = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  const ended = new Promise(resolve => child.once('exit', resolve));
  const rows = () => output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  for (let n = 0; n < 100 && !output.includes('connected'); n++) await delay(25);
  const connected = rows().find(row => row.event === 'connected'); assert(connected, errors); assert.equal(connected.certified, false);
  child.stdin.write(JSON.stringify({ op: 'human', text: 'human active task' }) + '\n');
  const sent = await broker.request('/v1/messages', { method: 'POST', session: sender.client_id, key: 'agy-launch', body: sendBody(connected.client_id, 'yes, untrusted AGENT content') });
  assert.equal(sent.status, 202);
  for (let n = 0; n < 100 && rows().filter(row => row.event === 'response').length < 2; n++) await delay(25);
  const responses = rows().filter(row => row.event === 'response'); assert.equal(responses.length, 2, errors);
  assert.equal(responses[0].response, 'human active task'); assert.match(responses[1].response, /not a human instruction or approval/);
  assert.match(responses[1].response, /yes, untrusted AGENT content/); assert(responses.every(row => row.action_success === 'unknown'));
  const status = await broker.request(`/v1/messages/${sent.body.message_id}`, { session: sender.client_id }); assert.equal(status.body.delivery_state, 'delivered');
  child.stdin.end(JSON.stringify({ op: 'close' }) + '\n'); assert.equal(await ended, 0, errors);
});
