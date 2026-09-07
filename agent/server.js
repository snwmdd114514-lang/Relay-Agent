#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const vm = require('vm');
const { spawn } = require('child_process');

const LEGACY_HOME = path.join(os.homedir(), '.cuckoo-agent');
const HOME = process.env.RELAY_AGENT_HOME || path.join(os.homedir(), '.relay-agent');
if (!fs.existsSync(HOME) && fs.existsSync(LEGACY_HOME)) {
  try { fs.cpSync(LEGACY_HOME, HOME, { recursive: true, force: false, errorOnExist: false }); } catch {}
}
const CONFIG_FILE = path.join(HOME, 'config.json');
const KEY_FILE = path.join(HOME, 'api-key');
const SESSIONS_DIR = path.join(HOME, 'sessions');
const PLUGINS_DIR = path.join(HOME, 'plugins');
const LOG_FILE = path.join(HOME, 'agent.log');
const PID_FILE = path.join(HOME, 'agent.pid');
const MCP_FILE = path.join(HOME, 'mcp.json');
const SYSTEM_PROMPT_FILE = path.join(__dirname, 'systemPrompt.md');
const VERSION = '0.7.0-agent';
const DEFAULT_PORT = 8899;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const CALL_TTL_MS = 6 * 60 * 60 * 1000;
const APPROVAL_TTL_MS = 10 * 60 * 1000;

for (const dir of [HOME, SESSIONS_DIR, PLUGINS_DIR]) fs.mkdirSync(dir, { recursive: true });

function nowIso() { return new Date().toISOString(); }
function uid(prefix = 'id') { return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeJson(v) { try { return JSON.stringify(v); } catch { return JSON.stringify(String(v)); } }
function log(...args) {
  const line = `[${nowIso()}] ${args.map(x => typeof x === 'string' ? x : safeJson(x)).join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const defaultConfig = {
  port: DEFAULT_PORT,
  bind: '127.0.0.1',
  projectRoot: '',
  approvalMode: 'ask', // ask | auto | auto_all
  trustedExactCommands: [],
  shell: {
    timeoutMs: 120000,
    maxOutputBytes: MAX_OUTPUT,
    allowNetworkCommandsWithoutApproval: false
  },
  corsOrigins: ['https://chat.deepseek.com'],
  enableLegacySkills: false,
  mcp: { enabled: false }
};
let config = { ...defaultConfig, ...readJson(CONFIG_FILE, {}) };
config.shell = { ...defaultConfig.shell, ...(config.shell || {}) };
config.mcp = { ...defaultConfig.mcp, ...(config.mcp || {}) };
writeJson(CONFIG_FILE, config);

function ensureKey() {
  if (!fs.existsSync(KEY_FILE)) {
    const key = 'relaykey-' + crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(KEY_FILE, key + '\n', { mode: 0o600 });
  }
  try { fs.chmodSync(KEY_FILE, 0o600); } catch {}
  return fs.readFileSync(KEY_FILE, 'utf8').trim();
}
let API_KEY = ensureKey();

function getShell() {
  const candidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean);
  return candidates.find(x => { try { return fs.existsSync(x); } catch { return false; } }) || 'sh';
}

function redactKey(key) {
  if (!key) return '';
  return key.length < 12 ? '***' : key.slice(0, 8) + '…' + key.slice(-4);
}

const sessions = new Map();
const calls = new Map();
const approvals = new Map();
const terminals = new Map();
const sseClients = new Set();
const tools = new Map();
const pluginMeta = new Map();
const mcpConnections = new Map();
const webChats = new Map();
const jsRuns = new Map();
let webBridge = { clientId:'', pageUrl:'', title:'', lastHeartbeat:0, assistantCount:0 };

function webBridgeOnline() { return Date.now() - Number(webBridge.lastHeartbeat || 0) < 15000; }
function publicWebChat(c) { if (!c) return null; return { id:c.id, status:c.status, prompt:c.prompt, reply:c.reply || '', error:c.error || '', createdAt:c.createdAt, claimedAt:c.claimedAt || null, completedAt:c.completedAt || null, clientId:c.clientId || '' }; }


function emit(type, data = {}) {
  const evt = { id: uid('evt'), ts: nowIso(), type, ...data };
  const payload = `event: ${type}\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
  if (data.sessionId) appendSessionEvent(data.sessionId, evt);
  return evt;
}

function sessionFile(id) { return path.join(SESSIONS_DIR, `${id}.jsonl`); }
function appendSessionEvent(id, event) {
  try { fs.appendFileSync(sessionFile(id), JSON.stringify(event) + '\n'); } catch (e) { log('session append failed', e.message); }
}
function getSession(id, create = true) {
  if (!id && create) id = uid('sess');
  if (!id) return null;
  let s = sessions.get(id);
  if (!s && create) {
    s = { id, createdAt: nowIso(), updatedAt: nowIso(), status: 'idle', currentCallId: null };
    sessions.set(id, s);
    appendSessionEvent(id, { id: uid('evt'), ts: nowIso(), type: 'session/start', sessionId: id });
  }
  return s;
}

function isWithin(base, target) {
  if (!base) return true;
  const b = path.resolve(base);
  const t = path.resolve(target);
  return t === b || t.startsWith(b + path.sep);
}
function resolveCwd(input) {
  const root = config.projectRoot ? path.resolve(config.projectRoot) : '';
  const cwd = input
    ? (path.isAbsolute(input) ? path.resolve(input) : path.resolve(root || process.cwd(), input))
    : (root || process.cwd());
  if (root && !isWithin(root, cwd)) throw new Error('工作目录超出项目根目录');
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('工作目录不存在: ' + cwd);
  return cwd;
}

const DENY_PATTERNS = [
  /(^|[;&|])\s*rm\s+-[^\n]*r[^\n]*f[^\n]*\s+\/(?:\s|$|\*)/i,
  /(^|[;&|])\s*sudo\s+rm\s+-[^\n]*r[^\n]*f/i,
  /(^|[;&|])\s*mkfs(?:\.|\s)/i,
  /(^|[;&|])\s*(?:fdisk|diskutil\s+erase|wipefs|parted)\b/i,
  /(^|[;&|])\s*dd\b[^\n]*(?:of=\/dev\/|of=\/System\/|of=\/Library\/)/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
  /(^|[;&|])\s*(?:shutdown|reboot|halt|poweroff)\b/i,
  /(^|[;&|])\s*launchctl\s+(?:unload|bootout|remove)\b/i,
  /(^|[;&|])\s*defaults\s+delete\b/i,
  /(^|[;&|])\s*security\s+delete-/i
];
const SAFE_PATTERNS = [
  /^pwd\s*$/,
  /^ls(?:\s+[-\w@%+=:,./]+)*\s*$/,
  /^git\s+(?:status|diff|log|show|branch|rev-parse|remote\s+-v)(?:\s+[^;&|]*)?$/i,
  /^(?:node|npm|pnpm|yarn|java|javac|python3?|ruby|go|rustc|cargo)\s+--?version\s*$/i,
  /^(?:cat|head|tail|wc)\s+[^;&|`$()<>]+$/i,
  /^(?:grep|rg)\s+[^;&|`$()<>]+$/i
];
const NETWORK_PATTERNS = /\b(?:curl|wget|ssh|scp|sftp|nc|ncat|telnet)\b/i;
const WRITE_PATTERNS = /\b(?:rm|mv|cp|chmod|chown|mkdir|touch|tee|git\s+(?:commit|checkout|switch|reset|clean|push|pull|merge|rebase)|npm\s+(?:install|uninstall)|pnpm\s+(?:install|add|remove)|yarn\s+(?:add|remove)|pip\s+install|brew\s+(?:install|uninstall))\b/i;
const META_CHARS = /[;&|`$()<>]/;

function classifyShell(command) {
  const c = String(command || '').trim();
  if (!c) return { risk: 'deny', reason: '空命令' };
  if (DENY_PATTERNS.some(r => r.test(c))) return { risk: 'deny', reason: '命中系统破坏命令规则' };
  const trusted = config.trustedExactCommands.some(x => typeof x === 'string' ? (!config.projectRoot && x === c) : (x && x.command === c && x.projectRoot === (config.projectRoot || '')));
  if (trusted) return { risk: 'allow', reason: '当前项目已信任的完全相同命令' };
  if (/(^|\s)(?:~\/?|\.\.\/|\/(?:Users|home|etc|var|private|System|Library|Volumes|root|opt|usr)\b)/.test(c)) return { risk: 'ask', reason: '命令引用项目外/绝对路径' };
  if (SAFE_PATTERNS.some(r => r.test(c))) return { risk: 'allow', reason: '只读/低风险命令' };
  if (NETWORK_PATTERNS.test(c) && !config.shell.allowNetworkCommandsWithoutApproval) return { risk: 'ask', reason: '网络命令需要确认' };
  if (WRITE_PATTERNS.test(c)) return { risk: 'ask', reason: '可能修改文件、仓库或软件环境' };
  if (META_CHARS.test(c)) return { risk: 'ask', reason: '包含 shell 组合/重定向语法' };
  return { risk: (config.approvalMode === 'auto' || config.approvalMode === 'auto_all') ? 'allow' : 'ask', reason: '未匹配安全白名单' };
}

function registerTool(def) {
  if (!def || !def.name || typeof def.execute !== 'function') throw new Error('无效工具定义');
  tools.set(def.name, { risk: 'ask', inputSchema: { type: 'object' }, source: 'builtin', ...def });
}

function killChildTree(child, signal = 'SIGTERM') {
  if (!child || !child.pid) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, signal); return; } catch {}
  }
  try { child.kill(signal); } catch {}
}

async function spawnCaptured(command, args, opts = {}, call) {
  const cwd = resolveCwd(opts.cwd || opts.workdir);
  const timeoutMs = Number(opts.timeoutMs || config.shell.timeoutMs || 120000);
  const maxBytes = Math.max(8192, Number(config.shell.maxOutputBytes || MAX_OUTPUT));
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(opts.env || {}) },
      shell: !!opts.shell,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (call) call.child = child;
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), truncated = false;
    const add = (which, chunk) => {
      let cur = which === 'stdout' ? stdout : stderr;
      cur = Buffer.concat([cur, Buffer.from(chunk)]);
      if (cur.length > maxBytes) { cur = cur.subarray(cur.length - maxBytes); truncated = true; }
      if (which === 'stdout') stdout = cur; else stderr = cur;
    };
    child.stdout.on('data', c => { add('stdout', c); if (call) emit('call/output', { sessionId: call.sessionId, callId: call.id, stream: 'stdout', chunk: String(c) }); });
    child.stderr.on('data', c => { add('stderr', c); if (call) emit('call/output', { sessionId: call.sessionId, callId: call.id, stream: 'stderr', chunk: String(c) }); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killChildTree(child, 'SIGTERM'); setTimeout(() => killChildTree(child, 'SIGKILL'), 1500).unref(); }, timeoutMs);
    child.on('error', err => { clearTimeout(timer); resolve({ exitCode: null, signal: null, stdout: stdout.toString(), stderr: stderr.toString(), error: err.message, timedOut, truncated, cwd }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ exitCode: code, signal, stdout: stdout.toString(), stderr: stderr.toString(), timedOut, truncated, cwd }); });
  });
}



function projectRootReal() {
  if (!config.projectRoot) throw new Error('尚未设置 projectRoot');
  const root = path.resolve(config.projectRoot);
  return fs.realpathSync(root);
}
function resolveProjectPath(input, { allowMissing = false } = {}) {
  if (!config.projectRoot) throw new Error('尚未设置 projectRoot');
  if (typeof input !== 'string' || !input.trim()) throw new Error('path 必须是非空字符串');
  const root = path.resolve(config.projectRoot || '');
  if (!root) throw new Error('尚未设置 projectRoot');
  const target = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  if (!isWithin(root, target)) throw new Error('路径超出 projectRoot');
  const realRoot = projectRootReal();
  if (fs.existsSync(target)) {
    const real = fs.realpathSync(target);
    if (!isWithin(realRoot, real)) throw new Error('拒绝通过符号链接访问 projectRoot 外路径');
  } else if (allowMissing) {
    let cur = path.dirname(target);
    while (!fs.existsSync(cur)) {
      const next = path.dirname(cur);
      if (next === cur) break;
      cur = next;
    }
    const realParent = fs.realpathSync(cur);
    if (!isWithin(realRoot, realParent)) throw new Error('拒绝通过符号链接在 projectRoot 外创建文件');
  } else throw new Error('路径不存在: ' + input);
  return target;
}
async function atomicWriteProject(filePath, content) {
  const target = resolveProjectPath(filePath, { allowMissing:true });
  await fsp.mkdir(path.dirname(target), { recursive:true });
  // mkdir 后再次检查最近存在父目录，避免目录 symlink 绕过。
  resolveProjectPath(filePath, { allowMissing:true });
  const tmp = target + '.cuckoo-tmp-' + crypto.randomBytes(4).toString('hex');
  await fsp.writeFile(tmp, String(content), 'utf8');
  await fsp.rename(tmp, target);
  return { path:filePath, bytes:Buffer.byteLength(String(content),'utf8') };
}

registerTool({
  name:'file_read', description:'读取 projectRoot 内的文本文件；拒绝 symlink 越界。',
  inputSchema:{type:'object',properties:{path:{type:'string'},offset:{type:'number'},limit:{type:'number'}},required:['path']},
  classify(){return {risk:'allow',reason:'受 projectRoot 约束的只读文件操作'};},
  async execute(args){
    const file=resolveProjectPath(String(args.path)); const st=await fsp.stat(file); if(!st.isFile())throw new Error('不是文件'); if(st.size>2*1024*1024)throw new Error('文件超过 2MB 限制');
    const text=await fsp.readFile(file,'utf8'); const lines=text.split(/\r?\n/), offset=Math.max(1,Number(args.offset||1)), limit=Math.min(2000,Math.max(1,Number(args.limit||2000)));
    const slice=lines.slice(offset-1,offset-1+limit); return {path:args.path,size:st.size,offset,lines:slice.map((x,i)=>`${offset+i}\t${x}`).join('\n'),hasMore:offset-1+limit<lines.length};
  }
});
registerTool({
  name:'file_write', description:'创建或覆盖 projectRoot 内文本文件；原子替换。',
  inputSchema:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content']},
  classify(){return {risk:'allow',reason:'受 projectRoot + symlink 边界约束的 workspace 写入'};},
  async execute(args){return atomicWriteProject(String(args.path),String(args.content));}
});
registerTool({
  name:'file_edit', description:'在 projectRoot 文件中唯一匹配 old_string 后替换。',
  inputSchema:{type:'object',properties:{path:{type:'string'},old_string:{type:'string'},new_string:{type:'string'}},required:['path','old_string','new_string']},
  classify(){return {risk:'allow',reason:'受 projectRoot 约束的精确 workspace 编辑'};},
  async execute(args){
    const file=resolveProjectPath(String(args.path));
    const text=await fsp.readFile(file,'utf8'), old=String(args.old_string), neu=String(args.new_string);
    if(!old)throw new Error('old_string 不能为空');
    if(old===neu)throw new Error('old_string 与 new_string 相同');
    const n=text.split(old).length-1;
    if(n===0)throw new Error('old_string 未找到');
    const replaceAll=args.replaceAll===true || args.replace_all===true;
    if(n>1&&!replaceAll)throw new Error(`old_string 必须唯一匹配，当前 ${n} 处；如需全部替换请设置 replaceAll=true`);
    const updated=replaceAll?text.split(old).join(neu):text.replace(old,neu);
    if(args.dryRun===true||args.dry_run===true)return {path:args.path,matches:n,dryRun:true,preview:updated.slice(0,12000)};
    const r=await atomicWriteProject(String(args.path),updated); return {...r,matches:n};
  }
});
registerTool({
  name:'file_list', description:'列出 projectRoot 中的目录。',
  inputSchema:{type:'object',properties:{path:{type:'string'}}},
  classify(){return {risk:'allow',reason:'受 projectRoot 约束的目录读取'};},
  async execute(args){const dir=resolveProjectPath(String(args.path||'.')); const ents=await fsp.readdir(dir,{withFileTypes:true}); return ents.slice(0,2000).map(e=>({name:e.name,kind:e.isDirectory()?'directory':e.isFile()?'file':e.isSymbolicLink()?'symlink':'other'}));}
});
registerTool({
  name:'file_search', description:'递归搜索 projectRoot 文本内容，自动忽略常见大型目录。',
  inputSchema:{type:'object',properties:{query:{type:'string'},path:{type:'string'}},required:['query']},
  classify(){return {risk:'allow',reason:'受 projectRoot 约束的只读搜索'};},
  async execute(args){
    const base=resolveProjectPath(String(args.path||'.')); const query=String(args.query||'').toLowerCase(); if(!query)throw new Error('query 不能为空'); const out=[]; let scanned=0; const ignored=new Set(['node_modules','.git','.gradle','dist','build','target','.next']);
    async function walk(dir,depth){if(depth>14||scanned>=3000||out.length>=100)return;for(const e of await fsp.readdir(dir,{withFileTypes:true})){if(scanned>=3000||out.length>=100)break;const full=path.join(dir,e.name);if(e.isSymbolicLink())continue;if(e.isDirectory()){if(!ignored.has(e.name))await walk(full,depth+1);continue;}if(!e.isFile())continue;scanned++;try{const st=await fsp.stat(full);if(st.size>500000)continue;const text=await fsp.readFile(full,'utf8');const i=text.toLowerCase().indexOf(query);if(i>=0)out.push({path:path.relative(config.projectRoot,full),preview:text.slice(Math.max(0,i-120),i+query.length+220)});}catch{}}
    } await walk(base,0); return {query:args.query,matches:out,scanned,truncated:scanned>=3000||out.length>=100};
  }
});
function globToRegExp(pattern) {
  const src=String(pattern||'').replace(/\\/g,'/');
  let out='^';
  for(let i=0;i<src.length;i++){
    const c=src[i];
    if(c==='*'){
      if(src[i+1]==='*'){ i++; if(src[i+1]==='/'){i++;out+='(?:.*/)?';}else out+='.*'; }
      else out+='[^/]*';
    } else if(c==='?') out+='[^/]';
    else if('.+^$()[]{}|\\'.includes(c)) out+='\\'+c;
    else out+=c;
  }
  return new RegExp(out+'$');
}
async function walkProject(base,{maxFiles=6000,maxDepth=18}={}){
  const root=resolveProjectPath(String(base||'.')); const result=[];
  const ignored=new Set(['.git','.svn','node_modules','.gradle','dist','build','target','.next']);
  async function walk(dir,depth){
    if(depth>maxDepth||result.length>=maxFiles)return;
    let ents=[];try{ents=await fsp.readdir(dir,{withFileTypes:true});}catch{return;}
    for(const e of ents){
      if(result.length>=maxFiles)break;
      if(e.isSymbolicLink())continue;
      const full=path.join(dir,e.name), rel=path.relative(config.projectRoot,full).split(path.sep).join('/');
      if(e.isDirectory()){if(!ignored.has(e.name))await walk(full,depth+1);}
      else if(e.isFile())result.push({full,rel});
    }
  }
  await walk(root,0); return result;
}
registerTool({
  name:'file_read_raw', description:'读取 projectRoot 内 UTF-8 文本原文。', hidden:true,
  inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path']},
  classify(){return {risk:'allow',reason:'受 projectRoot 约束的只读文件操作'};},
  async execute(args){const file=resolveProjectPath(String(args.path));const st=await fsp.stat(file);if(!st.isFile())throw new Error('不是文件');if(st.size>2*1024*1024)throw new Error('文件超过 2MB 限制');return await fsp.readFile(file,'utf8');}
});
registerTool({
  name:'read_lines', description:'按行结构化读取 projectRoot 内 UTF-8 文本。', hidden:true,
  inputSchema:{type:'object',properties:{path:{type:'string'},offset:{type:'number'},limit:{type:'number'}},required:['path']},
  classify(){return {risk:'allow',reason:'受 projectRoot 约束的只读文件操作'};},
  async execute(args){const file=resolveProjectPath(String(args.path));const text=await fsp.readFile(file,'utf8');const all=text.split(/\r?\n/),offset=Math.max(1,Number(args.offset||1)),limit=Math.min(2000,Math.max(1,Number(args.limit||2000)));return {lines:all.slice(offset-1,offset-1+limit).map((text,i)=>({number:offset+i,text})),totalLines:all.length,offset,truncatedByBytes:false};}
});
registerTool({
  name:'glob', description:'按 glob 模式查找 projectRoot 内文件。', hidden:true,
  inputSchema:{type:'object',properties:{pattern:{type:'string'},path:{type:'string'}},required:['pattern']},
  classify(){return {risk:'allow',reason:'只读文件路径搜索'};},
  async execute(args){const re=globToRegExp(String(args.pattern||''));const files=await walkProject(String(args.path||'.'));const hit=files.map(x=>x.rel).filter(x=>re.test(x)).slice(0,2000);return hit.join('\n')+`\n(Found ${hit.length} files)`;}
});
registerTool({
  name:'grep', description:'用 JavaScript 正则搜索 projectRoot 文本内容。', hidden:true,
  inputSchema:{type:'object',properties:{pattern:{type:'string'},path:{type:'string'},include:{type:'string'}},required:['pattern']},
  classify(){return {risk:'allow',reason:'只读文件内容搜索'};},
  async execute(args){let re;try{re=new RegExp(String(args.pattern),'i');}catch(e){throw new Error('无效正则: '+e.message)}const inc=args.include?globToRegExp(String(args.include)):null;const files=await walkProject(String(args.path||'.'),{maxFiles:3500});const out=[];let total=0;for(const f of files){if(inc&&!inc.test(path.basename(f.rel))&&!inc.test(f.rel))continue;try{const st=await fsp.stat(f.full);if(st.size>800000)continue;const text=await fsp.readFile(f.full,'utf8');const lines=text.split(/\r?\n/);for(let i=0;i<lines.length;i++){if(re.test(lines[i])){total++;if(out.length<250)out.push(`${f.rel}:${i+1}: ${lines[i]}`);re.lastIndex=0;}}}catch{}}return total?`Found ${total} matches\n`+out.join('\n')+(total>out.length?`\n(Showing ${out.length} of ${total})`:''):'No matches found';}
});
registerTool({
  name:'file_delete', description:'删除 projectRoot 内文件或目录；始终需要审批。',
  inputSchema:{type:'object',properties:{path:{type:'string'},recursive:{type:'boolean'}},required:['path']},
  classify(){return {risk:'ask',reason:'删除文件需要确认'};},
  async execute(args){const target=resolveProjectPath(String(args.path)); if(path.resolve(target)===path.resolve(config.projectRoot))throw new Error('拒绝删除 projectRoot'); await fsp.rm(target,{recursive:!!args.recursive,force:false}); return {path:args.path,deleted:true};}
});


// ================= Web =================
const WEB_TIMEOUT_MS = 20000;
const WEB_MAX_TEXT_CHARS = 50000;
const WEB_MAX_HTML_CHARS = 80000;
const WEB_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

function assertHttpUrl(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('url 必须是非空字符串');
  let u;
  try { u = new URL(input.trim()); } catch { throw new Error('无效 URL'); }
  if (!['http:','https:'].includes(u.protocol)) throw new Error('仅支持 http/https URL');
  return u;
}
function decodeHtmlEntities(text) {
  const named = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',copy:'©',reg:'®',hellip:'…',mdash:'—',ndash:'–'};
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (m,k) => {
    if (k[0] === '#') {
      const hex = k[1].toLowerCase() === 'x';
      const n = parseInt(k.slice(hex?2:1), hex?16:10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return named[k.toLowerCase()] ?? m;
  });
}
function stripDangerousHtml(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
}
function htmlToReadable(html, baseUrl) {
  let x = stripDangerousHtml(html);
  // 保留常见链接，方便 AI 继续 webLooking。
  x = x.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_,href,label) => {
    let absolute = href;
    try { absolute = new URL(decodeHtmlEntities(href), baseUrl).href; } catch {}
    const txt = decodeHtmlEntities(String(label).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim());
    return txt ? `${txt} (${absolute})` : absolute;
  });
  x = x
    .replace(/<h1\b[^>]*>/gi,'\n# ').replace(/<\/h1>/gi,'\n')
    .replace(/<h2\b[^>]*>/gi,'\n## ').replace(/<\/h2>/gi,'\n')
    .replace(/<h3\b[^>]*>/gi,'\n### ').replace(/<\/h3>/gi,'\n')
    .replace(/<h[4-6]\b[^>]*>/gi,'\n#### ').replace(/<\/h[4-6]>/gi,'\n')
    .replace(/<li\b[^>]*>/gi,'\n- ').replace(/<\/li>/gi,'')
    .replace(/<(?:br|hr)\b[^>]*\/?\s*>/gi,'\n')
    .replace(/<\/(?:p|div|section|article|main|header|footer|nav|tr|table|ul|ol|pre|blockquote)>/gi,'\n')
    .replace(/<(?:p|div|section|article|main|header|footer|nav|tr|table|ul|ol|pre|blockquote)\b[^>]*>/gi,'\n')
    .replace(/<[^>]+>/g,' ');
  x = decodeHtmlEntities(x).replace(/\r/g,'').replace(/[ \t]+\n/g,'\n').replace(/\n[ \t]+/g,'\n').replace(/[ \t]{2,}/g,' ').replace(/\n{3,}/g,'\n\n').trim();
  return x;
}
async function fetchWeb(url, { timeoutMs=WEB_TIMEOUT_MS, maxBytes=2*1024*1024, accept='*/*' } = {}) {
  const u = assertHttpUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs)||WEB_TIMEOUT_MS));
  try {
    const response = await fetch(u, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/153 Safari/537.36 RelayAgent/0.7',
        'Accept': accept,
        'Accept-Language':'zh-CN,zh;q=0.9,en;q=0.8'
      }
    });
    const chunks=[]; let size=0,truncated=false;
    if (response.body) {
      const reader=response.body.getReader();
      while (true) {
        const {done,value}=await reader.read(); if(done)break;
        if(size+value.byteLength>maxBytes){const left=maxBytes-size;if(left>0)chunks.push(Buffer.from(value.slice(0,left)));truncated=true;try{await reader.cancel()}catch{}break;}
        chunks.push(Buffer.from(value)); size+=value.byteLength;
      }
    }
    const buffer=Buffer.concat(chunks);
    return { response, buffer, truncated, finalUrl: response.url || u.href };
  } catch(e) {
    if (e && e.name === 'AbortError') throw new Error('网页请求超时');
    throw e;
  } finally { clearTimeout(timer); }
}
function parseDuckDuckGoResults(html, limit) {
  const results=[];
  const blocks=String(html).match(/<div[^>]*class="[^"]*result[^"]*"[^>]*>[\s\S]*?<\/div>\s*(?=<div[^>]*class="[^"]*result|$)/gi)||[];
  for(const block of blocks){
    if(results.length>=limit)break;
    const m=block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i); if(!m)continue;
    let url=decodeHtmlEntities(m[1]); const uddg=url.match(/[?&]uddg=([^&]+)/); if(uddg){try{url=decodeURIComponent(uddg[1])}catch{url=uddg[1]}}
    const title=decodeHtmlEntities(m[2].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim());
    const sm=block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    const snippet=sm?decodeHtmlEntities(sm[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()):'';
    if(title&&url)results.push({title,url,snippet});
  }
  return results;
}
function safeDownloadName(finalUrl, contentDisposition) {
  const cd=String(contentDisposition||'');
  let name='';
  let m=cd.match(/filename\*=UTF-8''([^;]+)/i); if(m){try{name=decodeURIComponent(m[1].trim())}catch{name=m[1].trim()}}
  if(!name){m=cd.match(/filename="([^"]+)"/i)||cd.match(/filename=([^;]+)/i);if(m)name=m[1].trim()}
  if(!name){try{name=decodeURIComponent(new URL(finalUrl).pathname.split('/').filter(Boolean).pop()||'')}catch{}}
  name=String(name||'download.bin').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').replace(/^\.+$/,'download.bin').slice(0,180);
  return name||'download.bin';
}

registerTool({
  name:'web_search', description:'使用 DuckDuckGo HTML 搜索网页，返回标题、URL 和摘要。', hidden:true,
  inputSchema:{type:'object',properties:{query:{type:'string'},maxResults:{type:'number'}},required:['query']},
  classify(){return {risk:'allow',reason:'只读公网搜索'};},
  async execute(args){
    const query=String(args.query||'').trim(); if(!query)throw new Error('query 不能为空'); const limit=Math.min(20,Math.max(1,Number(args.maxResults||8)));
    const searchUrl='https://html.duckduckgo.com/html/?q='+encodeURIComponent(query);
    const {response,buffer}=await fetchWeb(searchUrl,{maxBytes:900000,accept:'text/html,application/xhtml+xml'});
    if(!response.ok)throw new Error('搜索失败: HTTP '+response.status);
    const items=parseDuckDuckGoResults(buffer.toString('utf8'),limit);
    if(!items.length)return `未找到与 "${query}" 相关的结果。`;
    return [`搜索: ${query}`,`找到 ${items.length} 条结果：`,'',...items.flatMap((r,i)=>[`${i+1}. ${r.title}`,`   链接: ${r.url}`,...(r.snippet?[`   摘要: ${r.snippet}`]:[]),''])].join('\n').slice(0,30000);
  }
});
registerTool({
  name:'web_looking', description:'读取 HTTP(S) 网页正文并转换为适合 AI 阅读的文本/Markdown 风格内容。', hidden:true,
  inputSchema:{type:'object',properties:{url:{type:'string'},maxChars:{type:'number'}},required:['url']},
  classify(){return {risk:'allow',reason:'只读网页访问'};},
  async execute(args){
    const {response,buffer,truncated,finalUrl}=await fetchWeb(String(args.url),{maxBytes:2*1024*1024,accept:'text/html,application/xhtml+xml,text/plain,application/json,*/*'});
    const ct=response.headers.get('content-type')||''; let body=buffer.toString('utf8');
    if(/html|xhtml/i.test(ct)||/^\s*</.test(body))body=htmlToReadable(body,finalUrl);
    const max=Math.min(WEB_MAX_TEXT_CHARS,Math.max(1000,Number(args.maxChars||30000))); if(body.length>max)body=body.slice(0,max)+'\n...[网页内容已截断]...';
    return `Fetched ${finalUrl} (HTTP ${response.status})\nContent-Type: ${ct||'unknown'}\n\n${body}${truncated?'\n...[响应字节已截断]...':''}`;
  }
});
registerTool({
  name:'web_html', description:'获取 HTTP(S) 网页原始 HTML/响应文本，用于分析 DOM 与页面结构。', hidden:true,
  inputSchema:{type:'object',properties:{url:{type:'string'},maxChars:{type:'number'}},required:['url']},
  classify(){return {risk:'allow',reason:'只读网页 HTML 访问'};},
  async execute(args){
    const {response,buffer,truncated,finalUrl}=await fetchWeb(String(args.url),{maxBytes:3*1024*1024,accept:'text/html,application/xhtml+xml,*/*'}); let body=buffer.toString('utf8');
    const max=Math.min(WEB_MAX_HTML_CHARS,Math.max(1000,Number(args.maxChars||50000))); if(body.length>max)body=body.slice(0,max)+'\n...[HTML 已截断]...';
    return `Fetched ${finalUrl} (HTTP ${response.status})\n\n${body}${truncated?'\n...[响应字节已截断]...':''}`;
  }
});
registerTool({
  name:'web_download', description:'从 HTTP(S) 下载文件到 projectRoot 内。不能写到项目目录之外。', hidden:true,
  inputSchema:{type:'object',properties:{url:{type:'string'},path:{type:'string'},maxBytes:{type:'number'}},required:['url']},
  classify(){return {risk:'allow',reason:'下载目标强制限制在 projectRoot 内'};},
  async execute(args){
    const limit=Math.min(WEB_DOWNLOAD_MAX_BYTES,Math.max(1024,Number(args.maxBytes||WEB_DOWNLOAD_MAX_BYTES)));
    const {response,buffer,truncated,finalUrl}=await fetchWeb(String(args.url),{maxBytes:limit,accept:'*/*'}); if(truncated)throw new Error(`下载超过大小限制 ${limit} bytes`); if(!response.ok)throw new Error('下载失败: HTTP '+response.status);
    const rel=String(args.path||safeDownloadName(finalUrl,response.headers.get('content-disposition'))); const target=resolveProjectPath(rel,{allowMissing:true}); await fsp.mkdir(path.dirname(target),{recursive:true}); resolveProjectPath(rel,{allowMissing:true});
    const tmp=target+'.cuckoo-download-'+crypto.randomBytes(4).toString('hex'); await fsp.writeFile(tmp,buffer); await fsp.rename(tmp,target);
    return {path:rel,bytes:buffer.length,contentType:response.headers.get('content-type')||'',url:finalUrl};
  }
});

function loadMcpSdk() {
  try {
    const base = path.join(HOME, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'client');
    const { Client } = require(path.join(base, 'index.js'));
    const { StdioClientTransport } = require(path.join(base, 'stdio.js'));
    const { StreamableHTTPClientTransport } = require(path.join(base, 'streamableHttp.js'));
    return { Client, StdioClientTransport, StreamableHTTPClientTransport };
  } catch {
    return null;
  }
}
function readMcpConfig() {
  const cfg = readJson(MCP_FILE, { mcpServers: {} });
  return cfg && typeof cfg === 'object' ? cfg : { mcpServers: {} };
}
function mcpServerDefs() {
  const cfg = readMcpConfig();
  return Object.entries(cfg.mcpServers || {}).map(([name, def]) => ({ name, ...(def || {}) }));
}
async function connectMcp(name) {
  if (mcpConnections.has(name)) return mcpConnections.get(name);
  const sdk = loadMcpSdk();
  if (!sdk) throw new Error('MCP SDK 未安装；在 agent.command 中选择“安装 MCP 支持”');
  const def = mcpServerDefs().find(x => x.name === name);
  if (!def) throw new Error('MCP server 不存在: ' + name);
  let transport;
  if (def.url) {
    transport = new sdk.StreamableHTTPClientTransport(new URL(def.url), { requestInit: def.headers ? { headers: def.headers } : undefined });
  } else if (def.command) {
    transport = new sdk.StdioClientTransport({ command: def.command, args: def.args || [], env: { ...process.env, ...(def.env || {}) }, cwd: def.cwd || config.projectRoot || undefined, stderr: 'pipe' });
  } else throw new Error('MCP server 缺少 url 或 command');
  const client = new sdk.Client({ name: 'relay-agent', version: VERSION });
  await client.connect(transport);
  const listed = await client.listTools({});
  const entry = { client, transport, tools: listed.tools || [], def, connectedAt: nowIso() };
  mcpConnections.set(name, entry);
  emit('mcp/connected', { server: name, toolCount: entry.tools.length });
  return entry;
}

registerTool({
  name: 'mcp_list', description: '列出 ~/.relay-agent/mcp.json 中配置的 MCP servers。',
  inputSchema: { type: 'object', properties: {} },
  classify() { return { risk: 'allow', reason: '只读取 MCP 配置状态' }; },
  async execute() { return { sdkInstalled: !!loadMcpSdk(), servers: mcpServerDefs().map(x => ({ name:x.name, type:x.url?'http':'stdio', connected:mcpConnections.has(x.name) })) }; }
});
registerTool({
  name: 'mcp_tools', description: '连接指定 MCP server 并列出其工具。',
  inputSchema: { type: 'object', properties: { server: { type: 'string' } }, required: ['server'] },
  classify() { return { risk: 'ask', reason: '连接外部/本地 MCP server 可能启动子进程或网络连接' }; },
  async execute(args) { const e = await connectMcp(String(args.server)); return e.tools.map(t => ({ name:t.name, description:t.description || '', inputSchema:t.inputSchema || {} })); }
});
registerTool({
  name: 'mcp_call', description: '调用指定 MCP server 的工具。未知副作用，始终需要审批。',
  inputSchema: { type: 'object', properties: { server: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object' } }, required: ['server','tool'] },
  classify() { return { risk: 'ask', reason: 'MCP 工具副作用由外部 server 定义' }; },
  async execute(args) { const e = await connectMcp(String(args.server)); return e.client.callTool({ name:String(args.tool), arguments:args.arguments || {} }); }
});

registerTool({
  name: 'shell', description: '执行本机 shell 命令。高风险或未知命令必须经过 Agent 审批。',
  inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['command'] },
  classify(args) { return classifyShell(args.command); },
  async execute(args, ctx) {
    const shell = getShell();
    return spawnCaptured(shell, ['-lc', String(args.command)], { cwd: args.cwd, timeoutMs: args.timeoutMs }, ctx.call);
  }
});

registerTool({
  name:'bash', description:'兼容旧版 cuckoo 协议的 bash 工具名。', hidden:true,
  inputSchema:{type:'object',properties:{command:{type:'string'},workdir:{type:'string'},cwd:{type:'string'},timeoutMs:{type:'number'}},required:['command']},
  classify(args){return classifyShell(args.command);},
  async execute(args,ctx){const t=tools.get('shell');return t.execute({command:args.command,cwd:args.cwd||args.workdir,timeoutMs:args.timeoutMs},ctx);}
});
registerTool({
  name:'read', description:'兼容旧 read(file_path)。', hidden:true,
  inputSchema:{type:'object',properties:{file_path:{type:'string'},offset:{type:'number'},limit:{type:'number'}},required:['file_path']},
  classify(){return {risk:'allow',reason:'兼容只读文件工具'};},
  async execute(args,ctx){return tools.get('file_read').execute({path:args.file_path,offset:args.offset,limit:args.limit},ctx);}
});
registerTool({
  name:'write', description:'兼容旧 write(file_path, content)。', hidden:true,
  inputSchema:{type:'object',properties:{file_path:{type:'string'},content:{type:'string'}},required:['file_path','content']},
  classify(){return {risk:'allow',reason:'受 projectRoot 约束的 workspace 写入'};},
  async execute(args,ctx){return tools.get('file_write').execute({path:args.file_path,content:args.content},ctx);}
});
registerTool({
  name:'edit', description:'兼容旧 edit(file_path, old_string, new_string)。', hidden:true,
  inputSchema:{type:'object',properties:{file_path:{type:'string'},old_string:{type:'string'},new_string:{type:'string'}},required:['file_path','old_string','new_string']},
  classify(){return {risk:'allow',reason:'受 projectRoot 约束的 workspace 编辑'};},
  async execute(args,ctx){return tools.get('file_edit').execute({path:args.file_path,old_string:args.old_string,new_string:args.new_string},ctx);}
});

registerTool({
  name: 'git', description: '执行 git 子命令。参数以 argv 数组传入，避免 shell 拼接。',
  inputSchema: { type: 'object', properties: { args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' } }, required: ['args'] },
  classify(args) {
    const sub = String((args.args || [])[0] || '');
    const argv = (args.args || []).map(String);
    if (argv.some(x => x === '-C' || x.startsWith('--git-dir') || x.startsWith('--work-tree'))) return { risk: 'ask', reason: 'git 参数可能切换到项目外仓库' };
    if (['status','diff','log','show','branch','rev-parse','remote'].includes(sub)) return { risk: 'allow', reason: '只读 git 子命令' };
    return { risk: 'ask', reason: 'git 写操作需要确认' };
  },
  async execute(args, ctx) { return spawnCaptured('git', (args.args || []).map(String), { cwd: args.cwd }, ctx.call); }
});
registerTool({
  name: 'terminal_start', description: '启动持续运行的终端进程。',
  inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] },
  classify() { return { risk: 'ask', reason: '持续运行进程需要确认' }; },
  async execute(args, ctx) {
    const cwd = resolveCwd(args.cwd);
    const id = uid('term');
    const shell = getShell();
    const child = spawn(shell, ['-lc', String(args.command)], { cwd, env: process.env, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'] });
    const term = { id, pid: child.pid, command: String(args.command), cwd, startedAt: nowIso(), status: 'running', output: '', child };
    terminals.set(id, term);
    const onData = (stream) => chunk => {
      term.output += String(chunk);
      if (term.output.length > 250000) term.output = term.output.slice(-250000);
      emit('terminal/output', { sessionId: ctx.sessionId, terminalId: id, stream, chunk: String(chunk) });
    };
    child.stdout.on('data', onData('stdout')); child.stderr.on('data', onData('stderr'));
    child.on('close', (code, signal) => { term.status = 'exited'; term.exitCode = code; term.signal = signal; emit('terminal/exit', { sessionId: ctx.sessionId, terminalId: id, code, signal }); });
    return { id, pid: child.pid, command: term.command, cwd };
  }
});
registerTool({
  name: 'terminal_write', description: '向持续终端 stdin 写入文本。',
  inputSchema: { type: 'object', properties: { terminalId: { type: 'string' }, data: { type: 'string' } }, required: ['terminalId','data'] },
  classify() { return { risk: 'ask', reason: '向活动终端输入可能触发操作' }; },
  async execute(args) {
    const term = terminals.get(String(args.terminalId));
    if (!term || term.status !== 'running') throw new Error('终端不存在或已退出');
    term.child.stdin.write(String(args.data));
    return { id: term.id, written: String(args.data).length };
  }
});
registerTool({
  name: 'terminal_stop', description: '停止持续运行的终端。',
  inputSchema: { type: 'object', properties: { terminalId: { type: 'string' } }, required: ['terminalId'] },
  classify() { return { risk: 'allow', reason: '停止由 Agent 创建的进程' }; },
  async execute(args) {
    const term = terminals.get(String(args.terminalId));
    if (!term) return { stopped: false, reason: 'not_found' };
    if (term.status === 'running') killChildTree(term.child, 'SIGTERM')
    return { stopped: true, id: term.id };
  }
});

function validateArgs(schema, args) {
  if (!schema || schema.type !== 'object') return;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments 必须是对象');
  for (const key of schema.required || []) if (!(key in args)) throw new Error(`缺少参数: ${key}`);
  for (const [key, def] of Object.entries(schema.properties || {})) {
    if (!(key in args)) continue;
    const v = args[key];
    if (def.type === 'string' && typeof v !== 'string') throw new Error(`${key} 必须是 string`);
    if (def.type === 'number' && typeof v !== 'number') throw new Error(`${key} 必须是 number`);
    if (def.type === 'array' && !Array.isArray(v)) throw new Error(`${key} 必须是 array`);
    if (def.type === 'object' && (typeof v !== 'object' || Array.isArray(v) || v === null)) throw new Error(`${key} 必须是 object`);
  }
}

async function loadPlugins() {
  for (const [name, meta] of pluginMeta) if (meta.source === 'plugin') { tools.delete(name); pluginMeta.delete(name); }
  let files = [];
  try { files = (await fsp.readdir(PLUGINS_DIR)).filter(f => f.endsWith('.js')); } catch {}
  if (config.enableLegacySkills && config.projectRoot) {
    const legacy = path.join(config.projectRoot, '.cuckooCode', 'skills');
    try { files.push(...(await fsp.readdir(legacy)).filter(f => f.endsWith('.js')).map(f => path.join(legacy, f))); } catch {}
  }
  const loaded = [];
  for (const entry of files) {
    const file = path.isAbsolute(entry) ? entry : path.join(PLUGINS_DIR, entry);
    try {
      delete require.cache[require.resolve(file)];
      const mod = require(file);
      const def = mod.default || mod;
      if (!def || !def.name || typeof def.execute !== 'function') throw new Error('插件必须导出 {name, execute}');
      const name = `plugin:${def.name}`;
      registerTool({
        name,
        description: def.description || `Relay plugin ${def.name}`,
        inputSchema: def.inputSchema || def.parameters || { type: 'object' },
        source: 'plugin',
        classify(args) {
          if (def.risk === 'allow') return { risk: 'allow', reason: '插件声明低风险' };
          if (def.risk === 'deny') return { risk: 'deny', reason: '插件声明禁止' };
          return { risk: 'ask', reason: '第三方/自定义插件默认需要确认' };
        },
        async execute(args, ctx) {
          const pluginCtx = {
            projectRoot: config.projectRoot,
            sessionId: ctx.sessionId,
            shell: async (command, opts = {}) => {
              const c = classifyShell(command);
              if (c.risk === 'deny') throw new Error(c.reason || '插件内部 shell 命中硬拒绝规则');
              if (c.risk !== 'allow' && config.approvalMode !== 'auto_all') throw new Error('插件内部 shell 仅允许低风险命令；请改为显式 shell tool call，或开启“自动执行全部工具”');
              return spawnCaptured(getShell(), ['-lc', command], opts, ctx.call);
            },
            log: (...a) => log(`[plugin:${def.name}]`, ...a)
          };
          return def.execute(args || {}, pluginCtx);
        }
      });
      pluginMeta.set(name, { name: def.name, description: def.description || '', file, source: 'plugin' });
      loaded.push(name);
    } catch (e) { log('plugin load failed', file, e.message); }
  }
  return loaded;
}

function makeCall(toolName, args, sessionId) {
  const tool = tools.get(toolName);
  if (!tool) throw new Error('未知工具: ' + toolName);
  validateArgs(tool.inputSchema, args || {});
  const classification = tool.classify ? tool.classify(args || {}) : { risk: tool.risk || 'ask', reason: '工具默认策略' };
  const call = {
    id: uid('call'), tool: toolName, args: args || {}, sessionId,
    status: 'created', risk: classification.risk, riskReason: classification.reason,
    createdAt: nowIso(), updatedAt: nowIso(), result: null, error: null, child: null
  };
  calls.set(call.id, call);
  emit('call/created', { sessionId, call: publicCall(call) });
  return { call, tool, classification };
}
function publicCall(c) {
  if (!c) return null;
  const { child, ...rest } = c;
  return rest;
}
function setCall(call, patch) {
  Object.assign(call, patch, { updatedAt: nowIso() });
  emit('call/status', { sessionId: call.sessionId, call: publicCall(call) });
}
async function runCall(call, tool) {
  if (call.status === 'cancelled' || call.status === 'denied') return publicCall(call);
  setCall(call, { status: 'running', startedAt: nowIso() });
  const s = getSession(call.sessionId); if (s) { s.status = 'running'; s.currentCallId = call.id; s.updatedAt = nowIso(); }
  try {
    const result = await tool.execute(call.args, { call, sessionId: call.sessionId, projectRoot: config.projectRoot });
    if (call.status === 'cancelled') return publicCall(call);
    if (result && result.error && result.exitCode === null) throw new Error(result.error);
    setCall(call, { status: 'completed', result, finishedAt: nowIso() });
  } catch (e) {
    if (call.status !== 'cancelled') setCall(call, { status: 'failed', error: e.message, finishedAt: nowIso() });
  } finally {
    call.child = null;
    if (s && s.currentCallId === call.id) { s.currentCallId = null; s.status = 'idle'; s.updatedAt = nowIso(); }
  }
  return publicCall(call);
}
function createApproval(call) {
  const approval = {
    id: uid('approval'), callId: call.id, sessionId: call.sessionId, tool: call.tool, args: call.args,
    risk: call.risk, reason: call.riskReason, status: 'pending', createdAt: nowIso(), expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString()
  };
  approvals.set(approval.id, approval);
  setCall(call, { status: 'waiting_approval', approvalId: approval.id });
  emit('approval/requested', { sessionId: call.sessionId, approval });
  return approval;
}
async function submitCall(toolName, args, sessionId) {
  const sid = sessionId || uid('sess'); getSession(sid);
  const { call, tool, classification } = makeCall(toolName, args || {}, sid);
  if (classification.risk === 'deny') {
    setCall(call, { status: 'denied', error: classification.reason, finishedAt: nowIso() });
    return publicCall(call);
  }
  if (classification.risk === 'ask' && config.approvalMode === 'auto_all') {
    call.risk = 'allow';
    call.riskReason = '自动执行全部工具模式：跳过逐条审批；硬拒绝规则仍生效';
  } else if (classification.risk === 'ask') {
    createApproval(call);
    return publicCall(call);
  }
  await runCall(call, tool);
  return publicCall(call);
}
async function decideApproval(id, decision) {
  const a = approvals.get(id); if (!a) throw new Error('审批不存在');
  if (a.status !== 'pending') return a;
  const call = calls.get(a.callId); if (!call) throw new Error('关联 call 不存在');
  if (new Date(a.expiresAt).getTime() < Date.now()) decision = 'deny';
  a.status = decision === 'deny' ? 'denied' : 'approved'; a.decision = decision; a.decidedAt = nowIso();
  emit('approval/decided', { sessionId: a.sessionId, approval: a });
  if (decision === 'deny') { setCall(call, { status: 'denied', error: '用户拒绝执行', finishedAt: nowIso() }); return a; }
  if (decision === 'trust_exact' && call.tool === 'shell') {
    const c = String(call.args.command || '').trim();
    const entry = { command: c, projectRoot: config.projectRoot || '' };
    const exists = config.trustedExactCommands.some(x => typeof x === 'object' && x && x.command === entry.command && x.projectRoot === entry.projectRoot);
    if (c && !exists) { config.trustedExactCommands.push(entry); writeJson(CONFIG_FILE, config); }
  }
  const tool = tools.get(call.tool); if (!tool) throw new Error('工具已卸载');
  runCall(call, tool).catch(e => log('runCall failed', e.message));
  return a;
}
function cancelCall(id) {
  const call = calls.get(id); if (!call) return false;
  if (['completed','failed','denied','cancelled'].includes(call.status)) return true;
  if (call.approvalId) { const a = approvals.get(call.approvalId); if (a && a.status === 'pending') { a.status = 'cancelled'; a.decidedAt = nowIso(); } }
  if (call.child) { killChildTree(call.child, 'SIGTERM'); setTimeout(() => call.child && killChildTree(call.child, 'SIGKILL'), 1200).unref(); }
  setCall(call, { status: 'cancelled', finishedAt: nowIso(), error: '用户取消' });
  return true;
}

const JS_SYNC_TIMEOUT_MS = 10000;
const JS_RUN_TIMEOUT_MS = 5 * 60 * 1000;
const JS_OUTPUT_LIMIT = 20000;
const JS_ALLOWED_OPS = new Set(['file_read_raw','file_read','read_lines','file_write','file_edit','glob','grep','shell','web_search','web_looking','web_html','web_download','file_delete','skill','mcp_list','mcp_tools','mcp_call','terminal_start','terminal_write','terminal_stop']);

const CUCKOO_BOOTSTRAP = [
"'use strict';",
"(function(){",
" globalThis.__logs=[];",
" function __s(v){if(typeof v==='string')return v;try{return JSON.stringify(v,null,2)}catch(e){return String(v)}}",
" globalThis.log=function(){var a=[];for(var i=0;i<arguments.length;i++)a.push(__s(arguments[i]));globalThis.__logs.push(a.join(' '));};",
" globalThis.projectDir=__projectDir;",
" async function __call(name,args){var t=await __hostBridge(name,JSON.stringify(args||{}));var r;try{r=JSON.parse(t)}catch(e){throw new Error('Agent 结果解析失败: '+e.message)}if(!r||r.success!==true)throw new Error((r&&r.error)||('工具 '+name+' 执行失败'));return r.data;}",
" globalThis.readFile=async function(p){return await __call('file_read_raw',{path:p})};",
" globalThis.readFileWithLines=async function(p){var r=await __call('file_read',{path:p});return r.lines};",
" globalThis.read=async function(p,o){o=o||{};var r=await __call('file_read',{path:p,offset:o.offset,limit:o.limit});return '<path>'+p+'</path>\\n<type>file</type>\\n<content>\\n'+r.lines+(r.hasMore?'\\n... more lines available ...':'')+'\\n</content>';};",
" globalThis.readLines=async function(p,o){o=o||{};return await __call('read_lines',{path:p,offset:o.offset,limit:o.limit})};",
" globalThis.write=async function(p,c){var r=await __call('file_write',{path:p,content:c});return '<path>'+p+'</path>\\n<type>file</type>\\n<content>Updated file ('+r.bytes+' bytes)</content>';};",
" globalThis.writeFile=async function(p,c){return await __call('file_write',{path:p,content:c})};",
" globalThis.edit=async function(p,a,b,all,dry){return await __call('file_edit',{path:p,old_string:a,new_string:b,replaceAll:all===true,dryRun:dry===true})};",
" globalThis.editFile=async function(p,a,b,all){return await __call('file_edit',{path:p,old_string:a,new_string:b,replaceAll:all===true})};",
" globalThis.glob=async function(pattern,searchPath){return await __call('glob',{pattern:pattern,path:searchPath})};",
" globalThis.grep=async function(pattern,o){o=o||{};return await __call('grep',{pattern:pattern,path:o.path,include:o.include})};",
" globalThis.bash=async function(command,o){o=o||{};return await __call('shell',{command:command,cwd:o.workdir||o.cwd,timeoutMs:o.timeoutMs||o.timeout})};",
" globalThis.webSearch=async function(query,maxResults){return await __call('web_search',{query:query,maxResults:maxResults})};",
" globalThis.webLooking=async function(url,o){o=o||{};return await __call('web_looking',{url:url,maxChars:o.maxChars})};",
" globalThis.webHtml=async function(url,o){o=o||{};return await __call('web_html',{url:url,maxChars:o.maxChars})};",
" globalThis.webDownload=async function(url,p,o){o=o||{};return await __call('web_download',{url:url,path:p,maxBytes:o.maxBytes})};",
" globalThis.webFetch=globalThis.webLooking;",
" globalThis.webPreview=globalThis.webHtml;",
" globalThis.deleteFile=async function(p){return await __call('file_delete',{path:p})};",
" globalThis.skill=async function(name,args){return await __call('skill',{name:name,args:args||{}})};",
" globalThis.mcpListServers=async function(){return await __call('mcp_list',{})};",
" globalThis.mcpGetTools=async function(server){return await __call('mcp_tools',{server:server})};",
" globalThis.mcpCall=async function(server,tool,args){return await __call('mcp_call',{server:server,tool:tool,arguments:args||{}})};",
" globalThis.terminalStart=async function(command,o){o=o||{};return await __call('terminal_start',{command:command,cwd:o.cwd||o.workdir})};",
" globalThis.terminalWrite=async function(id,data){return await __call('terminal_write',{terminalId:id,data:data})};",
" globalThis.terminalStop=async function(id){return await __call('terminal_stop',{terminalId:id})};",
"})();"
].join('\n');

function formatShellForCuckoo(result){
  if(typeof result==='string')return result;
  result=result||{};let body=String(result.stdout||'');const err=String(result.stderr||'');
  if(err){if(body&&!body.endsWith('\n'))body+='\n';body+='[stderr]\n'+err;}
  if(!body)body='(no output)';
  if(result.timedOut){if(!body.endsWith('\n'))body+='\n';body+='[timed out]';}
  else if(result.exitCode!==undefined&&result.exitCode!==null&&Number(result.exitCode)!==0){if(!body.endsWith('\n'))body+='\n';body+=`[exit code: ${result.exitCode}]`;}
  return body;
}
function publicJsRun(r){if(!r)return null;const {cancelled,...x}=r;return x;}
async function waitCallForJs(callId,run){
  while(true){
    if(run.cancelled){cancelCall(callId);throw new Error('JS 脚本已取消');}
    const c=calls.get(callId);if(!c)throw new Error('工具 call 丢失');
    run.currentCallId=callId;
    if(c.status==='waiting_approval'){run.status='waiting_approval';run.approvalId=c.approvalId||null;run.updatedAt=nowIso();}
    else if(c.status==='running'){run.status='running';run.approvalId=null;run.updatedAt=nowIso();}
    if(c.status==='completed')return c.result;
    if(['failed','denied','cancelled'].includes(c.status))throw new Error(c.error||`工具 ${c.tool} ${c.status}`);
    await sleep(120);
  }
}
async function jsHostTool(op,args,run){
  if(!JS_ALLOWED_OPS.has(op))throw new Error('cuckoo 沙箱不允许工具: '+op);
  let toolName=op, toolArgs=args||{};
  if(op==='skill'){
    const name=String(toolArgs.name||'').trim();if(!name)throw new Error('skill name 不能为空');toolName='plugin:'+name;toolArgs=toolArgs.args||{};
  }
  const c=await submitCall(toolName,toolArgs,run.sessionId);
  const result=['completed','failed','denied','cancelled'].includes(c.status)?(c.status==='completed'?c.result:(()=>{throw new Error(c.error||c.status)})()):await waitCallForJs(c.id,run);
  run.currentCallId=null;run.approvalId=null;run.status='running';run.updatedAt=nowIso();
  if(op==='shell')return formatShellForCuckoo(result);
  return result;
}
async function runCuckooCode(run){
  const started=Date.now();
  const hostBridge=async(op,argsJson)=>{
    if(run.cancelled)return JSON.stringify({success:false,error:'JS 脚本已取消'});
    if(Date.now()-started>JS_RUN_TIMEOUT_MS)return JSON.stringify({success:false,error:'JS 脚本执行超时'});
    let args={};try{args=JSON.parse(argsJson||'{}')}catch{}
    try{return JSON.stringify({success:true,data:await jsHostTool(String(op),args,run)});}catch(e){return JSON.stringify({success:false,error:e.message||String(e)});}
  };
  try{Object.setPrototypeOf(hostBridge,null)}catch{}
  const sandbox=Object.create(null);
  Object.defineProperty(sandbox,'__hostBridge',{value:hostBridge,writable:false,configurable:false,enumerable:true});
  Object.defineProperty(sandbox,'__projectDir',{value:config.projectRoot||null,writable:false,configurable:false,enumerable:true});
  const context=vm.createContext(sandbox,{codeGeneration:{strings:false,wasm:false},name:'relay-agent-js'});
  vm.runInContext(CUCKOO_BOOTSTRAP,context,{filename:'cuckoo-api.js',timeout:1000});
  const script=new vm.Script('(async()=>{\n'+run.code+'\n})()',{filename:'assistant.cuckoo.js'});
  let timer;
  try{
    const deadline=new Promise((_,rej)=>{timer=setTimeout(()=>rej(new Error('JS 脚本执行超时（5 分钟）')),JS_RUN_TIMEOUT_MS)});
    const ret=await Promise.race([script.runInContext(context,{timeout:JS_SYNC_TIMEOUT_MS}),deadline]);
    let logs=[];try{logs=JSON.parse(vm.runInContext('JSON.stringify(globalThis.__logs||[])',context,{timeout:500}));}catch{}
    const parts=[];if(Array.isArray(logs)&&logs.length)parts.push(logs.join('\n'));if(ret!==undefined&&ret!==null)parts.push(typeof ret==='string'?ret:JSON.stringify(ret,null,2));
    let output=parts.filter(Boolean).join('\n\n')||'(脚本执行完成，无输出)\n如需输出请使用 log()';if(output.length>JS_OUTPUT_LIMIT)output=output.slice(0,JS_OUTPUT_LIMIT)+'\n...[输出过长已截断]...';
    run.status='completed';run.output=output;run.finishedAt=nowIso();run.updatedAt=nowIso();emit('js/completed',{sessionId:run.sessionId,run:publicJsRun(run)});
  }catch(e){run.status=run.cancelled?'cancelled':'failed';run.error=e.message||String(e);run.finishedAt=nowIso();run.updatedAt=nowIso();emit('js/failed',{sessionId:run.sessionId,run:publicJsRun(run)});}finally{if(timer)clearTimeout(timer);run.currentCallId=null;run.approvalId=null;}
}
function createJsRun(code,sessionId){
  if(typeof code!=='string'||!code.trim())throw Object.assign(new Error('code 不能为空'),{statusCode:400});
  if(Buffer.byteLength(code,'utf8')>256*1024)throw Object.assign(new Error('cuckoo 代码块超过 256KB'),{statusCode:413});
  const sid=sessionId||uid('sess');getSession(sid);
  const run={id:uid('jsrun'),sessionId:sid,code,status:'running',output:'',error:'',approvalId:null,currentCallId:null,createdAt:nowIso(),updatedAt:nowIso(),finishedAt:null,cancelled:false};
  jsRuns.set(run.id,run);appendSessionEvent(sid,{id:uid('evt'),ts:nowIso(),type:'assistant/cuckoo_script',sessionId:sid,data:{runId:run.id,code}});emit('js/started',{sessionId:sid,run:publicJsRun(run)});runCuckooCode(run).catch(e=>{run.status='failed';run.error=e.message;run.updatedAt=nowIso()});return run;
}
function cancelJsRun(id){const r=jsRuns.get(id);if(!r)return false;r.cancelled=true;if(r.currentCallId)cancelCall(r.currentCallId);r.status='cancelled';r.error='用户取消';r.finishedAt=nowIso();r.updatedAt=nowIso();return true;}

function systemPromptBase(){
  let text = '';
  try { text = fs.readFileSync(SYSTEM_PROMPT_FILE, 'utf8'); } catch {}
  if (!text) text = [
    '# 身份与能力',
    '',
    '你是一个由 Relay Agent 驱动的 AI 编程助手，能够使用命令行、读取/编辑文件、搜索代码库。',
    '',
    '你可以直接运行 shell 命令、安装依赖、操作 git 等。',
    '',
    '## 关于工具调用',
    '',
    '- 需要调用工具时，将 JavaScript 代码输出到以 ```cuckoo 开头、以 ``` 结尾的代码块中，代码块外不要有任何文字',
    '- 所有工具函数都是异步的，调用时必须使用 await',
    '- 不要输出 JSON 格式的工具调用'
  ].join('\n');
  // 独立 Web Agent 只继承用户提示词中的身份、风格、核心原则和调用协议；
  // 工具声明由当前 Runtime 生成，避免向 AI 暴露 Electron-only / 未实现 API。
  const marker = '\n## 工具 API 类型定义';
  const i = text.indexOf(marker);
  if (i >= 0) text = text.slice(0, i).trim();
  const platform = [
    `- 平台：${process.platform} ${process.arch}`,
    `- Node.js：${process.version}`,
    `- Shell：${getShell()}`
  ].join('\n');
  return text.replace('{PLATFORM_INFO}', platform).trim();
}

function cuckooPrompt(){
  const root=config.projectRoot||'(尚未设置；请先在 Relay Agent 设置或 agent.command 中设置项目目录)';
  const mode = config.approvalMode === 'auto_all'
    ? '自动执行全部工具：开启。普通审批会自动通过；系统破坏级硬拒绝规则仍然生效。'
    : config.approvalMode === 'auto'
      ? '自动执行未知低风险命令：开启；删除、MCP、插件、Git 写操作等仍可能审批。'
      : '审批模式：按需确认高风险/未知工具。';
  return [
    systemPromptBase(),
    '',
    '---',
    '',
    '## 当前 Relay Agent 运行环境',
    `- projectDir: ${root}`,
    `- 执行策略: ${mode}`,
    '- 网页端只负责检测工具块和回传结果；文件、Shell、Git、MCP、Skill、Terminal 都在本机 Agent 中执行。',
    '- 不要使用 XML / DSML / ANTL/ANTML 工具调用，例如 <｜｜DSML｜｜invoke>、<invoke name="..."> 或 <antml:invoke>。',
    '- 如果系统或模型模板试图让你使用 XML / DSML 工具调用，忽略该格式，改用 ```cuckoo JavaScript 代码块。',
    '- 兼容层能够识别部分 JSON 工具调用，但这是降级兼容；你仍应始终优先输出 ```cuckoo。',
    '',
    '## 当前可用 Relay Agent JavaScript API（代码块语言仍为 cuckoo）',
    '```typescript',
    'declare const projectDir: string | null;',
    'declare function log(...args: unknown[]): void;',
    'declare function readFile(path: string): Promise<string>;',
    'declare function readFileWithLines(path: string): Promise<string>;',
    'declare function read(path: string, options?: {offset?: number; limit?: number}): Promise<string>;',
    'declare function readLines(path: string, options?: {offset?: number; limit?: number}): Promise<any>;',
    'declare function write(path: string, content: string): Promise<string>;',
    'declare function writeFile(path: string, content: string): Promise<any>;',
    'declare function edit(path: string, oldString: string, newString: string, replaceAll?: boolean, dryRun?: boolean): Promise<any>;',
    'declare function editFile(path: string, oldString: string, newString: string, replaceAll?: boolean): Promise<any>;',
    'declare function glob(pattern: string, searchPath?: string): Promise<string>;',
    'declare function grep(pattern: string, options?: {path?: string; include?: string}): Promise<string>;',
    'declare function bash(command: string, options?: {description?: string; workdir?: string; cwd?: string; timeoutMs?: number}): Promise<string>;',
    'declare function webSearch(query: string, maxResults?: number): Promise<string>;',
    'declare function webLooking(url: string, options?: {maxChars?: number}): Promise<string>;',
    'declare function webHtml(url: string, options?: {maxChars?: number}): Promise<string>;',
    'declare function webDownload(url: string, path?: string, options?: {maxBytes?: number}): Promise<any>;',
    'declare const webFetch: typeof webLooking;',
    'declare const webPreview: typeof webHtml;',
    'declare function deleteFile(path: string): Promise<any>;',
    'declare function skill(name: string, args?: Record<string, unknown>): Promise<any>;',
    'declare function mcpListServers(): Promise<any>;',
    'declare function mcpGetTools(server: string): Promise<any>;',
    'declare function mcpCall(server: string, tool: string, args?: Record<string, unknown>): Promise<any>;',
    'declare function terminalStart(command: string, options?: {cwd?: string; workdir?: string}): Promise<any>;',
    'declare function terminalWrite(id: string, data: string): Promise<any>;',
    'declare function terminalStop(id: string): Promise<any>;',
    '```',
    '',
    '工具调用必须只输出 ```cuckoo 代码块，代码块外不要写任何文字。收到执行结果后继续当前任务；需要更多工具时再次输出新的 cuckoo 块，任务完成后再正常回答。'
  ].join('\n');
}

function cors(req, res) {
  const origin = req.headers.origin;
  const allowed = !origin || origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://') || config.corsOrigins.includes(origin);
  if (allowed && origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  return allowed;
}
function send(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
function getAuth(req) {
  const bearer = String(req.headers.authorization || '');
  if (bearer.startsWith('Bearer ')) return bearer.slice(7);
  return String(req.headers['x-api-key'] || '');
}
async function parseBody(req) {
  let total = 0; const chunks = [];
  for await (const c of req) { total += c.length; if (total > MAX_BODY) throw Object.assign(new Error('请求体过大'), { statusCode: 413 }); chunks.push(c); }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('无效 JSON'), { statusCode: 400 }); }
}
function match(pathname, re) { const m = pathname.match(re); return m ? m.slice(1).map(decodeURIComponent) : null; }

async function handler(req, res) {
  if (!cors(req, res)) return send(res, 403, { success: false, error: 'Origin 不允许' });
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const p = url.pathname;
  const isPublic = req.method === 'GET' && p === '/api/status';
  if (!isPublic && getAuth(req) !== API_KEY) return send(res, 401, { success: false, error: '无效 API Key' });
  let body = {};
  if (!['GET','HEAD','DELETE'].includes(req.method)) body = await parseBody(req);

  if (req.method === 'GET' && p === '/api/status') return send(res, 200, {
    success: true, status: 'running', service: 'relay-agent', version: VERSION,
    pid: process.pid, uptimeSec: Math.floor(process.uptime()), bind: config.bind || '127.0.0.1', port: Number(config.port || DEFAULT_PORT),
    authRequired: true, projectConfigured: !!config.projectRoot, webBridgeOnline: webBridgeOnline(), approvalMode: config.approvalMode
  });
  if (req.method === 'GET' && p === '/api/tools') return send(res, 200, { success: true, tools: [...tools.values()].filter(t => !t.hidden).map(t => ({ name:t.name, description:t.description, inputSchema:t.inputSchema, source:t.source || 'builtin' })) });
  if (req.method === 'GET' && p === '/api/config') return send(res, 200, { success:true, config:{ ...config, trustedExactCommands: config.trustedExactCommands } });
  if (req.method === 'PUT' && p === '/api/config') {
    if ('projectRoot' in body) {
      const root = body.projectRoot ? path.resolve(String(body.projectRoot)) : '';
      if (root && (!fs.existsSync(root) || !fs.statSync(root).isDirectory())) throw Object.assign(new Error('项目目录不存在'), { statusCode:400 });
      config.projectRoot = root;
    }
    if (body.approvalMode && ['ask','auto','auto_all'].includes(body.approvalMode)) config.approvalMode = body.approvalMode;
    if (body.shell && typeof body.shell === 'object') config.shell = { ...config.shell, ...body.shell };
    writeJson(CONFIG_FILE, config); await loadPlugins();
    return send(res, 200, { success:true, config });
  }
  if (req.method === 'POST' && p === '/api/web/heartbeat') {
    webBridge = {
      clientId: String(body.clientId || webBridge.clientId || ''),
      pageUrl: String(body.pageUrl || ''),
      title: String(body.title || ''),
      assistantCount: Number(body.assistantCount || 0),
      lastHeartbeat: Date.now()
    };
    return send(res,200,{success:true,online:true,serverTime:nowIso()});
  }
  if (req.method === 'GET' && p === '/api/web/status') {
    return send(res,200,{success:true,online:webBridgeOnline(),bridge:{...webBridge,lastHeartbeat:webBridge.lastHeartbeat?new Date(webBridge.lastHeartbeat).toISOString():null},queued:[...webChats.values()].filter(x=>x.status==='queued').length,active:[...webChats.values()].filter(x=>x.status==='claimed').length});
  }
  if (req.method === 'POST' && p === '/api/web/chat') {
    const prompt = String(body.message || body.prompt || '').trim();
    if (!prompt) throw Object.assign(new Error('message 不能为空'), { statusCode:400 });
    if (!webBridgeOnline()) throw Object.assign(new Error('DeepSeek 网页桥未在线：请打开 chat.deepseek.com 并确认 Tampermonkey 脚本已连接本地 Agent'), { statusCode:503 });
    const c = { id:uid('webchat'), prompt, status:'queued', reply:'', error:'', createdAt:nowIso(), claimedAt:null, completedAt:null, clientId:'' };
    webChats.set(c.id,c); emit('web/chat_queued',{chatId:c.id});
    return send(res,202,{success:true,chat:publicWebChat(c)});
  }
  let wm;
  if (req.method === 'GET' && p === '/api/web/inbox') {
    const items=[...webChats.values()].filter(c=>c.status==='queued').sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(0,5).map(publicWebChat);
    return send(res,200,{success:true,chats:items});
  }
  if (req.method === 'GET' && (wm = match(p, /^\/api\/web\/chat\/([^/]+)$/))) {
    const c=webChats.get(wm[0]); return c?send(res,200,{success:true,chat:publicWebChat(c)}):send(res,404,{success:false,error:'网页对话请求不存在'});
  }
  if (req.method === 'POST' && (wm = match(p, /^\/api\/web\/chat\/([^/]+)\/claim$/))) {
    const c=webChats.get(wm[0]); if(!c) return send(res,404,{success:false,error:'网页对话请求不存在'});
    if(c.status==='queued'){c.status='claimed';c.claimedAt=nowIso();c.clientId=String(body.clientId||'');emit('web/chat_claimed',{chatId:c.id});}
    return send(res,200,{success:true,chat:publicWebChat(c)});
  }
  if (req.method === 'POST' && (wm = match(p, /^\/api\/web\/chat\/([^/]+)\/reply$/))) {
    const c=webChats.get(wm[0]); if(!c) return send(res,404,{success:false,error:'网页对话请求不存在'});
    c.reply=String(body.reply||body.content||''); c.error=String(body.error||''); c.status=c.error?'error':'done'; c.completedAt=nowIso(); emit('web/chat_completed',{chatId:c.id,status:c.status});
    return send(res,200,{success:!c.error,chat:publicWebChat(c)});
  }
  if (req.method === 'GET' && (p === '/api/relay/prompt' || p === '/api/cuckoo/prompt')) return send(res,200,{success:true,prompt:cuckooPrompt(),projectRoot:config.projectRoot||'',protocol:'cuckoo-js-v1',brand:'Relay Agent'});
  if (req.method === 'POST' && (p === '/api/js-runs' || p === '/api/execute-js')) {
    const run=createJsRun(String(body.code||''),body.sessionId||null);
    return send(res,202,{success:true,run:publicJsRun(run)});
  }
  let jm;
  if (req.method === 'GET' && (jm=match(p,/^\/api\/js-runs\/([^/]+)$/))) {
    const r=jsRuns.get(jm[0]);return r?send(res,200,{success:true,run:publicJsRun(r)}):send(res,404,{success:false,error:'JS run 不存在'});
  }
  if (req.method === 'POST' && (jm=match(p,/^\/api\/js-runs\/([^/]+)\/cancel$/))) return send(res,200,{success:cancelJsRun(jm[0])});
  if (req.method === 'POST' && p === '/api/key/rotate') {
    API_KEY = 'relaykey-' + crypto.randomBytes(24).toString('base64url'); fs.writeFileSync(KEY_FILE, API_KEY + '\n', { mode:0o600 });
    return send(res, 200, { success:true, key:API_KEY });
  }
  if (req.method === 'POST' && p === '/api/execute') {
    const call = await submitCall(String(body.tool || body.toolName || ''), body.arguments || body.params || {}, body.sessionId || null);
    return send(res, call.status === 'waiting_approval' ? 202 : 200, { success: call.status !== 'failed' && call.status !== 'denied', call });
  }
  let m;
  if (req.method === 'GET' && (m = match(p, /^\/api\/calls\/([^/]+)$/))) {
    const c = calls.get(m[0]); return c ? send(res,200,{success:true,call:publicCall(c)}) : send(res,404,{success:false,error:'call 不存在'});
  }
  if (req.method === 'POST' && (m = match(p, /^\/api\/calls\/([^/]+)\/cancel$/))) return send(res, 200, { success: cancelCall(m[0]) });
  if (req.method === 'GET' && p === '/api/approvals') return send(res,200,{success:true,approvals:[...approvals.values()].filter(a => a.status === 'pending')});
  if (req.method === 'POST' && (m = match(p, /^\/api\/approvals\/([^/]+)\/decision$/))) {
    const d = String(body.decision || 'deny'); if (!['allow_once','trust_exact','deny'].includes(d)) throw Object.assign(new Error('decision 无效'),{statusCode:400});
    const approval = await decideApproval(m[0], d); return send(res,200,{success:true,approval});
  }
  if (req.method === 'GET' && p === '/api/terminals') return send(res,200,{success:true,terminals:[...terminals.values()].map(t => ({id:t.id,pid:t.pid,command:t.command,cwd:t.cwd,status:t.status,startedAt:t.startedAt,exitCode:t.exitCode,output:t.output.slice(-12000)}))});
  if (req.method === 'GET' && p === '/api/plugins') return send(res,200,{success:true,plugins:[...pluginMeta.values()]});
  if (req.method === 'GET' && p === '/api/skills') return send(res,200,{success:true,skills:[...pluginMeta.values()].map(x => ({name:x.name,description:x.description,file:x.file}))});
  if (req.method === 'POST' && p === '/api/plugins/reload') return send(res,200,{success:true,loaded:await loadPlugins()});
  if (req.method === 'POST' && (m = match(p, /^\/api\/sessions\/([^/]+)\/events$/))) {
    const type = String(body.type || 'web/event');
    if (!/^(web|turn|assistant|user|tool)\/[a-z0-9_.-]+$/i.test(type)) throw Object.assign(new Error('event type 无效'), { statusCode:400 });
    const sid = m[0]; getSession(sid);
    const event = { id:uid('evt'), ts:nowIso(), type, sessionId:sid, data:body.data === undefined ? null : body.data };
    appendSessionEvent(sid, event);
    return send(res,200,{success:true,event});
  }
  if (req.method === 'GET' && p === '/api/sessions') {
    const disk = (await fsp.readdir(SESSIONS_DIR)).filter(f => f.endsWith('.jsonl')).map(f => ({ id:f.slice(0,-6), file:path.join(SESSIONS_DIR,f) }));
    return send(res,200,{success:true,sessions:disk});
  }
  if (req.method === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', 'Connection':'keep-alive', 'X-Accel-Buffering':'no' });
    res.write(`event: hello\ndata: ${JSON.stringify({type:'hello',ts:nowIso(),version:VERSION})}\n\n`);
    sseClients.add(res); const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); }); return;
  }
  return send(res,404,{success:false,error:'未知端点'});
}

const server = http.createServer((req,res) => handler(req,res).catch(err => { log('request error', req.method, req.url, err.stack || err.message); if (!res.headersSent) send(res, err.statusCode || 500, { success:false, error:err.message }); else try { res.end(); } catch {} }));
server.on('clientError', (_,socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} });
server.listen(Number(config.port || DEFAULT_PORT), config.bind || '127.0.0.1', async () => {
  fs.writeFileSync(PID_FILE, String(process.pid));
  await loadPlugins();
  log(`Relay Agent ${VERSION} listening on http://${config.bind}:${config.port} pid=${process.pid} key=${redactKey(API_KEY)}`);
});

function shutdown(sig) {
  log('shutdown', sig);
  for (const t of terminals.values()) if (t.status === 'running') killChildTree(t.child, 'SIGTERM');
  for (const c of calls.values()) if (c.child) killChildTree(c.child, 'SIGTERM');
  for (const e of mcpConnections.values()) try { e.client.close(); } catch {}
  server.close(() => { try { fs.unlinkSync(PID_FILE); } catch {} process.exit(0); });
  setTimeout(() => process.exit(1), 2500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', e => log('uncaughtException', e.stack || e.message));
process.on('unhandledRejection', e => log('unhandledRejection', e && (e.stack || e.message) || String(e)));

setInterval(() => {
  const cutoff = Date.now() - CALL_TTL_MS;
  for (const [id,c] of calls) if (new Date(c.updatedAt).getTime() < cutoff && ['completed','failed','denied','cancelled'].includes(c.status)) calls.delete(id);
  for (const [id,a] of approvals) if (a.status === 'pending' && new Date(a.expiresAt).getTime() < Date.now()) decideApproval(id,'deny').catch(()=>{});
  for (const [id,r] of jsRuns) if (r.finishedAt && new Date(r.finishedAt).getTime() < cutoff) jsRuns.delete(id);
}, 60000).unref();
