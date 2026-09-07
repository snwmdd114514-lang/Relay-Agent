#!/usr/bin/env node
'use strict';

const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');

const BASE = (process.env.RELAY_AGENT_URL || process.env.CUCKOO_AGENT_URL || 'http://127.0.0.1:8899').replace(/\/$/, '');
const KEY = process.env.RELAY_AGENT_KEY || process.env.CUCKOO_AGENT_KEY || '';
const EXPECTED_VERSION = process.env.RELAY_EXPECTED_VERSION || process.env.CUCKOO_EXPECTED_VERSION || '';
if (!KEY) { console.error('缺少 RELAY_AGENT_KEY'); process.exit(1); }

async function api(path, method='GET', body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type':'application/json', 'X-API-Key':KEY },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text(); let d;
  try { d = text ? JSON.parse(text) : {}; } catch { d = { raw:text }; }
  if (!r.ok && r.status !== 202) throw new Error(d.error || `HTTP ${r.status}`);
  d.__status = r.status; return d;
}

const rl = readline.createInterface({ input, output, terminal:!!input.isTTY });
const lineIterator = input.isTTY ? null : rl[Symbol.asyncIterator]();
async function ask(prompt='') {
  if (input.isTTY) return rl.question(prompt);
  if (prompt) output.write(prompt);
  const n = await lineIterator.next();
  return n.done ? '/exit' : String(n.value);
}

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function prettyBridge(s){
  const b=s.bridge||{};
  return [
    `网页桥: ${s.online?'在线':'离线'}`,
    `页面: ${b.pageUrl||'-'}`,
    `标题: ${b.title||'-'}`,
    `最后心跳: ${b.lastHeartbeat||'-'}`,
    `排队/处理中: ${s.queued||0}/${s.active||0}`
  ].join('\n');
}
async function waitReply(id){
  const started=Date.now();
  let last='';
  while(Date.now()-started < 10*60*1000){
    const d=await api('/api/web/chat/'+encodeURIComponent(id));
    const c=d.chat||{};
    if(c.status!==last){
      last=c.status;
      if(last==='claimed') process.stdout.write('\x1b[90m[网页已接收，等待 DeepSeek…]\x1b[0m\n');
    }
    if(c.status==='done') return c.reply||'';
    if(c.status==='error') throw new Error(c.error||'网页桥返回错误');
    await sleep(500);
  }
  throw new Error('等待 DeepSeek 网页回复超时');
}
async function oneTurn(text){
  const d=await api('/api/web/chat','POST',{message:text});
  const id=d.chat?.id;
  if(!id) throw new Error('Agent 未返回网页对话 ID');
  const reply=await waitReply(id);
  console.log(`\n\x1b[34mDeepSeek>\x1b[0m ${reply}`);
}

(async()=>{
  const st=await api('/api/status');
  if (EXPECTED_VERSION && st.version !== EXPECTED_VERSION) {
    throw new Error(`后台版本不匹配: 当前 ${st.version||'unknown'} / 安装包 ${EXPECTED_VERSION}。请在 agent.command 选择 12 强制修复/升级后台。`);
  }
  if (!String(st.version||'').startsWith('0.7.')) {
    throw new Error(`后台版本过旧: ${st.version||'unknown'}。当前客户端需要 0.7.x；请用当前 agent.command 重启/升级后台。`);
  }
  let bridge;
  try { bridge=await api('/api/web/status'); }
  catch (e) { throw new Error(`网页桥端点不可用（${e.message}）。这通常表示 8899 上仍是旧版 Agent。`); }
  console.log(`\nRelay Agent ${st.version} · PID ${st.pid}`);
  console.log(prettyBridge(bridge));
  if(!bridge.online){
    console.log('\n\x1b[33mDeepSeek 网页桥未在线。\x1b[0m');
    console.log('请先：');
    console.log('  1. 打开 https://chat.deepseek.com/ 并保持登录');
    console.log('  2. 确认 Relay Agent Tampermonkey 脚本显示“网页桥在线”');
    console.log('  3. 再回到这里');
  }
  console.log('\n这里不会调用 DeepSeek API，也不需要模型 API Key。');
  console.log('消息会被送进你当前打开的 DeepSeek 网页，再从网页 DOM 读取回复。');
  console.log('命令: /status 查看桥接状态 · /exit 退出\n');

  while(true){
    const text=(await ask('\x1b[32m你>\x1b[0m ')).trim();
    if(!text) continue;
    if(text==='/exit'||text==='/quit') break;
    if(text==='/status'){
      bridge=await api('/api/web/status');
      console.log(prettyBridge(bridge));
      continue;
    }
    try{ await oneTurn(text); }
    catch(e){ console.error('\x1b[31m错误:\x1b[0m',e.message); }
    console.log();
  }
  rl.close();
})().catch(e=>{ console.error(e.stack||e.message); process.exit(1); });
