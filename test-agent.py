#!/usr/bin/env python3
import json, os, pathlib, shutil, subprocess, tempfile, time, urllib.request, urllib.error, threading, http.server, socketserver
ROOT=pathlib.Path(__file__).resolve().parent
SERVER=ROOT/'agent'/'server.js'
PORT=18906
WEBPORT=0
home=pathlib.Path(tempfile.mkdtemp(prefix='relay-v07-home-'))
project=pathlib.Path(tempfile.mkdtemp(prefix='relay-v07-project-'))
(home/'.relay-agent'/'plugins').mkdir(parents=True)
(project/'src').mkdir()
(project/'src'/'a.txt').write_text('hello world\nsecond line\n')
(project/'delete.txt').write_text('delete me\n')
(home/'.relay-agent'/'config.json').write_text(json.dumps({'port':PORT,'bind':'127.0.0.1','projectRoot':str(project),'approvalMode':'ask','trustedExactCommands':[],'corsOrigins':['https://chat.deepseek.com']},indent=2))
env=os.environ.copy();env['HOME']=str(home)
class WebHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path=='/page':
            body=b'<html><head><title>Test</title><style>x{}</style></head><body><h1>Hello Web</h1><p>Readable body</p><a href="/next">Next</a><script>evil()</script></body></html>'
            self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        elif self.path=='/file.bin':
            body=b'RELAY-DOWNLOAD-OK'
            self.send_response(200);self.send_header('Content-Type','application/octet-stream');self.send_header('Content-Disposition','attachment; filename=sample.bin');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        else:
            self.send_response(404);self.end_headers()
    def log_message(self,*args): pass
class ReuseTCPServer(socketserver.TCPServer): allow_reuse_address=True
websrv=ReuseTCPServer(('127.0.0.1',WEBPORT),WebHandler)
WEBPORT=websrv.server_address[1]
threading.Thread(target=websrv.serve_forever,daemon=True).start()
proc=subprocess.Popen(['node',str(SERVER)],env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
base=f'http://127.0.0.1:{PORT}'
passes=[]
def check(name, cond, detail=''):
    if not cond: raise AssertionError(f'{name}: {detail}')
    passes.append(name); print('PASS',name)
def request(path,method='GET',body=None,key=None,expect=None):
    data=None if body is None else json.dumps(body).encode()
    headers={'Content-Type':'application/json'}
    if key: headers['X-API-Key']=key
    req=urllib.request.Request(base+path,data=data,method=method,headers=headers)
    try:
        with urllib.request.urlopen(req,timeout=5) as r: return r.status,json.load(r)
    except urllib.error.HTTPError as e:
        d=json.loads(e.read().decode() or '{}')
        if expect==e.code:return e.code,d
        raise

def wait_server():
    for _ in range(60):
        try:
            s,d=request('/api/status');return d
        except Exception:time.sleep(.05)
    raise RuntimeError('server did not start')
def wait_run(rid,key,allow_approval=False):
    for _ in range(240):
        _,d=request('/api/js-runs/'+rid,key=key);r=d['run']
        if r['status']=='waiting_approval' and allow_approval:return r
        if r['status'] in ('completed','failed','cancelled'):return r
        time.sleep(.05)
    raise RuntimeError('run timeout')
def start_run(code,key,sid='test'):
    _,d=request('/api/js-runs','POST',{'code':code,'sessionId':sid},key);return d['run']['id']
def approve_first(key,decision='allow_once'):
    _,d=request('/api/approvals',key=key);a=d['approvals'][0]
    request('/api/approvals/'+a['id']+'/decision','POST',{'decision':decision},key);return a
try:
    st=wait_server();check('status_public',st['version']=='0.7.0-agent' and st.get('service')=='relay-agent')
    key=(home/'.relay-agent'/'api-key').read_text().strip()
    code,d=request('/api/tools',key=None,expect=401);check('auth_required',code==401)
    _,d=request('/api/relay/prompt',key=key);check('prompt_is_relay_cuckoo_js','Relay Agent' in d['prompt'] and '```cuckoo' in d['prompt'] and 'webSearch' in d['prompt'] and 'webDownload' in d['prompt'] and 'DSML' in d['prompt'])
    r=wait_run(start_run('log(await readFile("src/a.txt"));',key),key);check('js_read',r['status']=='completed' and 'hello world' in r['output'])
    r=wait_run(start_run('await write("src/b.txt", `alpha\\nbeta`); await edit("src/b.txt","beta","gamma"); log(await readFile("src/b.txt"));',key),key);check('write_edit',r['status']=='completed' and 'gamma' in r['output'] and (project/'src'/'b.txt').read_text().endswith('gamma'))
    r=wait_run(start_run('log(await glob("**/*.txt")); log(await grep("hello", {path:".",include:"*.txt"}));',key),key);check('glob_grep','src/a.txt' in r['output'] and 'Found 1 matches' in r['output'])
    r=wait_run(start_run('log(await bash("pwd"));',key),key);check('safe_shell',r['status']=='completed' and str(project) in r['output'])

    weburl=f'http://127.0.0.1:{WEBPORT}'
    r=wait_run(start_run(f'log(typeof webSearch, typeof webLooking, typeof webHtml, typeof webDownload); log(await webLooking("{weburl}/page"));',key,'weblook'),key);check('web_looking',r['status']=='completed' and 'function function function function' in r.get('output','') and 'Hello Web' in r.get('output','') and 'Readable body' in r.get('output','') and 'evil()' not in r.get('output',''))
    r=wait_run(start_run(f'log(await webHtml("{weburl}/page"));',key,'webhtml'),key);check('web_html',r['status']=='completed' and '<h1>Hello Web</h1>' in r['output'] and '<script>evil()</script>' in r['output'])
    r=wait_run(start_run(f'log(await webDownload("{weburl}/file.bin","downloads/test.bin"));',key,'webdl'),key);check('web_download',r['status']=='completed' and (project/'downloads'/'test.bin').read_bytes()==b'RELAY-DOWNLOAD-OK')
    r=wait_run(start_run('log(await webFetch("'+weburl+'/page")); log((await webPreview("'+weburl+'/page")).slice(0,40));',key,'webalias'),key);check('web_aliases',r['status']=='completed' and 'Hello Web' in r['output'])
    request('/api/config','PUT',{'approvalMode':'auto_all'},key)
    (project/'auto-delete.txt').write_text('x')
    r=wait_run(start_run('await deleteFile("auto-delete.txt"); log("auto deleted");',key,'autoall'),key);check('auto_all_skips_approval',r['status']=='completed' and not (project/'auto-delete.txt').exists())
    r=wait_run(start_run('await bash("rm -rf /");',key),key);check('dangerous_shell_denied',r['status']=='failed' and '系统破坏' in r['error'])
    request('/api/config','PUT',{'approvalMode':'ask'},key)
    r=wait_run(start_run('await deleteFile("delete.txt"); log("deleted");',key,'del'),key,True);check('delete_waits_approval',r['status']=='waiting_approval');approve_first(key);r=wait_run(r['id'],key);check('delete_after_approval',r['status']=='completed' and not (project/'delete.txt').exists())
    r=wait_run(start_run('await bash("echo x > shell-made.txt"); log("ok");',key,'shellask'),key,True);check('shell_redirection_approval',r['status']=='waiting_approval');approve_first(key);r=wait_run(r['id'],key);check('shell_after_approval',r['status']=='completed' and (project/'shell-made.txt').exists())
    pathlib.Path('/tmp/relay-v07-secret.txt').write_text('SECRET')
    try:(project/'outside').symlink_to('/tmp',target_is_directory=True)
    except FileExistsError:pass
    r=wait_run(start_run('try{log(await readFile("outside/relay-v07-secret.txt"))}catch(e){log(e.message)}',key),key);check('symlink_boundary','符号链接' in r['output'] and 'SECRET' not in r['output'])
    r=wait_run(start_run('log(typeof process, typeof require, typeof global);',key),key);check('node_globals_hidden','undefined undefined undefined' in r['output'])
    r=wait_run(start_run('try{const F=({}).constructor.constructor;log(F("return typeof process")())}catch(e){log(e.message)}',key),key);check('string_code_generation_blocked','Code generation from strings disallowed' in r['output'])
    (home/'.relay-agent'/'plugins'/'hello.js').write_text("module.exports={name:'hello',risk:'allow',execute:async a=>({hello:a.name||'world'})};\n")
    request('/api/plugins/reload','POST',{},key)
    r=wait_run(start_run('log(await skill("hello",{name:"Ming"}));',key),key);check('skill_bridge',r['status']=='completed' and 'Ming' in r['output'])
    request('/api/web/heartbeat','POST',{'clientId':'testweb','pageUrl':'https://chat.deepseek.com/a/chat/s/test','title':'DeepSeek'},key)
    _,d=request('/api/web/chat','POST',{'message':'hello'},key);cid=d['chat']['id'];_,d=request('/api/web/inbox',key=key);check('web_bridge_queue',any(x['id']==cid for x in d['chats']))
    request(f'/api/web/chat/{cid}/claim','POST',{'clientId':'testweb'},key);request(f'/api/web/chat/{cid}/reply','POST',{'reply':'world'},key);_,d=request(f'/api/web/chat/{cid}',key=key);check('web_bridge_roundtrip',d['chat']['reply']=='world' and d['chat']['status']=='done')
    session_files=list((home/'.relay-agent'/'sessions').glob('*.jsonl'));check('session_jsonl',bool(session_files) and any('assistant/cuckoo_script' in f.read_text() for f in session_files))
    ui=(ROOT/'relay-agent.user.js').read_text()
    check('send_throttle_2_to_4_seconds','sendDelayMin:2000' in ui and 'sendDelayMax:4000' in ui and 'state.sendQueue' in ui and 'randomSendDelay' in ui)
    check('relay_brand','@name         Relay Agent for DeepSeek' in ui and 'Relay Agent v0.7.0' in ui and 'Cuckoo Code Web Agent' not in ui)
    print(f'RESULT {len(passes)}/{len(passes)} PASS')
finally:
    websrv.shutdown();websrv.server_close()
    proc.terminate()
    try:proc.wait(timeout=3)
    except:proc.kill()
    shutil.rmtree(home,ignore_errors=True);shutil.rmtree(project,ignore_errors=True)
