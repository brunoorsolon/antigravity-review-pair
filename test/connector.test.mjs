import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { readConnectorConfig } from '../src/connector-config.mjs';
import { startConnector } from '../src/connector.mjs';
import { httpFixture, registration, sendBody } from '../../ai-agent-msg-broker/test/helpers.mjs';

function files(t) { const dir=mkdtempSync(join(tmpdir(),'psst-connector-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir; }
test('config accepts private common bundle; rejects permissive, linked, insecure and wrong-client inputs',t=>{
  const dir=files(t),path=join(dir,'connection.json');
  const bundle={format:'broker-client-bundle-v1',protocol_version:'1',broker_url:'https://broker.example',token_file:'token',file_paths_relative_to:'connection_file_directory',authorization_header:'Authorization',authorization_scheme:'Bearer',insecure_development:false,allowed_client_types:['antigravity-cli'],scope:'psst'};
  const write=value=>writeFileSync(path,JSON.stringify(value),{mode:0o600});write(bundle);
  const config=readConnectorConfig(path,{});assert.equal(config.tokenFile,join(dir,'token'));assert.equal(config.name,'Antigravity');
  assert.equal(config.stateRoot,join(dir,'state'));assert.equal(config.metadata.model.source,'unknown');
  chmodSync(path,0o644);assert.throws(()=>readConnectorConfig(path,{}),/invalid_connector_configuration/);chmodSync(path,0o600);
  const link=join(dir,'link');symlinkSync(path,link);assert.throws(()=>readConnectorConfig(link,{}));
  for(const override of [{broker_url:'http://broker.example'},{token_file:'../token'},{allowed_client_types:['pi']},{authorization_scheme:'Basic'},{surprise:true}]){write({...bundle,...override});assert.throws(()=>readConnectorConfig(path,{}));}
});

function rpcStreams() {
 const input=new PassThrough(), responses=[];let buffer='';
 const output=new Writable({write(chunk,enc,cb){buffer+=chunk;while(buffer.includes('\n')){const i=buffer.indexOf('\n');responses.push(JSON.parse(buffer.slice(0,i)));buffer=buffer.slice(i+1);}cb();}});
 let seq=0;
 const notify=(method,params)=>input.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\n');
 const call=async(method,params)=>{const id=++seq;input.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');for(let i=0;i<500;i++){const result=responses.find(r=>r.id===id);if(result)return result;await delay(5);}throw new Error('RPC timeout');};
 return {input,output,call,notify};
}
test('standalone MCP handshake, two-message FIFO, explicit ACK, reply and host-close lifecycle', {timeout:15000}, async t=>{
 const broker=await httpFixture(t),dir=files(t),tokenFile=join(dir,'token');writeFileSync(tokenFile,broker.b.token,{mode:0o600});
 const sender=registration('pi');await broker.request('/v1/sessions',{method:'POST',body:sender});
 const rpc=rpcStreams();const connector=await startConnector({config:{brokerUrl:broker.base,tokenFile,stateRoot:join(dir,'state'),insecureDevelopment:true,metadata:{name:'Antigravity',model:{provider:null,id:null,source:'unknown'},project:null}},...rpc});t.after(()=>connector.close());
 const init=await rpc.call('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fixture',version:'1'}});assert.equal(init.result.serverInfo.name,'antigravity-broker-connector');rpc.notify('notifications/initialized',{});
 const tools=await rpc.call('tools/list',{});assert.equal(tools.result.tools.length,7);
 const tool=async(name,args={})=>{const r=await rpc.call('tools/call',{name,arguments:args});assert(!r.error,JSON.stringify(r));return JSON.parse(r.result.content[0].text);};
 assert.equal((await tool('broker_identity')).client_id,connector.identity.client_id);
 const ids=[];for(const text of ['one','two']){const r=await broker.request('/v1/messages',{method:'POST',session:sender.client_id,key:crypto.randomUUID(),body:sendBody(connector.identity.client_id,text)});assert.equal(r.status,202);ids.push(r.body.message_id);}
 for(let i=0;i<200&&connector.inbox.stats().pending_count<2;i++)await delay(10);
 const received=await tool('broker_receive');assert.equal(received.message_id,ids[0]);assert.match(received.message,/untrusted agent input/);
 const ack=await tool('broker_acknowledge',{message_id:received.message_id,receipt_token:received.receipt_token});assert.equal(ack.acknowledged,true);
 assert.equal((await tool('broker_receive')).message_id,ids[1]);
 const sent=await tool('broker_send',{recipient_id:sender.client_id,text:'reply',reply_to_message_id:ids[0],send_key:'reply-key'});assert(sent.message_id);
 const repeated=await tool('broker_send',{recipient_id:sender.client_id,text:'reply',reply_to_message_id:ids[0],send_key:'reply-key'});assert.equal(sent.message_id,repeated.message_id);
 const wrong=await rpc.call('tools/call',{name:'broker_acknowledge',arguments:{message_id:ids[1],receipt_token:'not-a-uuid'}});assert.equal(wrong.error.code,-32602);
 rpc.input.end();await connector.done;
 const own=await broker.request(`/v1/sessions/${connector.identity.client_id}`,{token:broker.b.token});assert.equal(own.body.closed,true);
});
test('CLI help works without config, credentials or broker checkout',async t=>{
 const child=spawn(process.execPath,[resolve('bin/psst-antigravity.mjs'),'--help'],{stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',b=>out+=b);const code=await new Promise(r=>child.on('exit',r));assert.equal(code,0);assert.match(out,/cooperative stdio MCP/);
});
test('startup cancellation closes without leaving broker registration loops alive', {timeout:5000}, async t=>{
 const broker=await httpFixture(t),dir=files(t),tokenFile=join(dir,'token');writeFileSync(tokenFile,broker.b.token,{mode:0o600});
 const controller=new AbortController(),rpc=rpcStreams();
 const pending=startConnector({config:{brokerUrl:broker.base,tokenFile,stateRoot:join(dir,'state'),insecureDevelopment:true,metadata:{name:'cancelled',model:{provider:null,id:null,source:'unknown'},project:null}},...rpc,signal:controller.signal});
 controller.abort();await assert.rejects(pending);
});
