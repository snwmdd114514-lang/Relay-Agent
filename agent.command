#!/bin/bash
set -u

# macOS 自带 bash 3.2 也可运行；保留 zsh 风格 print 调用的轻量兼容层。
print() {
  if [[ "${1:-}" == "-P" ]]; then shift; printf "%b\n" "$*"; else printf "%s\n" "$*"; fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_SERVER="$SCRIPT_DIR/agent/server.js"
SRC_CHAT="$SCRIPT_DIR/agent/chat-client.js"
LEGACY_HOME_DIR="$HOME/.cuckoo-agent"
HOME_DIR="$HOME/.relay-agent"
RUNTIME_DIR="$HOME_DIR/runtime"
SERVER="$RUNTIME_DIR/server.js"
CHAT_CLIENT="$RUNTIME_DIR/chat-client.js"
PID_FILE="$HOME_DIR/agent.pid"
KEY_FILE="$HOME_DIR/api-key"
LOG_FILE="$HOME_DIR/agent.log"
PLIST="$HOME/Library/LaunchAgents/com.relay.agent.plist"
LEGACY_PLIST="$HOME/Library/LaunchAgents/com.cuckoo.agent.plist"
LABEL="com.relay.agent"
LEGACY_LABEL="com.cuckoo.agent"
PORT=8899

c_blue='\033[38;5;69m'; c_green='\033[38;5;71m'; c_red='\033[38;5;203m'; c_yellow='\033[38;5;214m'; c_dim='\033[2m'; c_reset='\033[0m'

find_node() {
  local candidates
  candidates=("$(command -v node 2>/dev/null || true)" "/opt/homebrew/bin/node" "/usr/local/bin/node" "$HOME/.local/bin/node")
  for n in "${candidates[@]}"; do
    if [[ -n "$n" && -x "$n" ]]; then echo "$n"; return 0; fi
  done
  return 1
}

NODE="$(find_node || true)"
NPM="$(command -v npm 2>/dev/null || true)"
if [[ -z "$NPM" && -n "$NODE" && -x "$(dirname "$NODE")/npm" ]]; then NPM="$(dirname "$NODE")/npm"; fi

header() {
  clear
  print -P "${c_blue}╭────────────────────────────────────────────╮${c_reset}"
  print -P "${c_blue}│${c_reset}  Relay Agent    ${c_dim}Local AI tool runtime${c_reset}      ${c_blue}│${c_reset}"
  print -P "${c_blue}╰────────────────────────────────────────────╯${c_reset}"
  print -P "${c_dim}安装包版本: $(bundled_version 2>/dev/null || echo unknown)${c_reset}"
}

migrate_legacy_home() {
  if [[ ! -d "$HOME_DIR" && -d "$LEGACY_HOME_DIR" ]]; then
    mkdir -p "$HOME_DIR"
    cp -R "$LEGACY_HOME_DIR"/. "$HOME_DIR"/ 2>/dev/null || true
    print -P "${c_yellow}已从旧目录迁移配置:${c_reset} $LEGACY_HOME_DIR → $HOME_DIR"
  fi
}

stop_legacy_agent() {
  launchctl bootout "gui/$(id -u)/$LEGACY_LABEL" >/dev/null 2>&1 || launchctl unload "$LEGACY_PLIST" >/dev/null 2>&1 || true
}

ensure_runtime() {
  migrate_legacy_home
  mkdir -p "$RUNTIME_DIR" "$HOME_DIR/plugins" "$HOME_DIR/sessions" "$HOME/Library/LaunchAgents"
  if [[ ! -f "$SRC_SERVER" ]]; then
    print -P "${c_red}找不到:${c_reset} $SRC_SERVER"
    print "请保持 agent.command 与 agent/ 文件夹放在一起。"
    return 1
  fi
  if [[ ! -f "$SERVER" ]] || ! cmp -s "$SRC_SERVER" "$SERVER"; then
    cp "$SRC_SERVER" "$SERVER"
    chmod 700 "$SERVER"
  fi
  if [[ -f "$SRC_CHAT" ]] && { [[ ! -f "$CHAT_CLIENT" ]] || ! cmp -s "$SRC_CHAT" "$CHAT_CLIENT"; }; then
    cp "$SRC_CHAT" "$CHAT_CLIENT"
    chmod 700 "$CHAT_CLIENT"
  fi
}

is_running() {
  curl -fsS --max-time 1 "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1
}

bundled_version() {
  sed -n "s/^const VERSION = '\([^']*\)';/\1/p" "$SRC_SERVER" 2>/dev/null | head -n 1
}

running_version() {
  curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/status" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'
}

running_pid() {
  curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/status" 2>/dev/null | sed -n 's/.*"pid":\([0-9]*\).*/\1/p'
}

force_repair() {
  ensure_runtime || return 1
  local bundled live
  bundled="$(bundled_version)"
  live="$(running_version)"
  print -P "${c_yellow}强制修复后台:${c_reset} ${live:-stopped}  →  ${bundled:-unknown}"
  stop_agent >/dev/null 2>&1 || true
  sleep 0.25
  ensure_runtime || return 1
  write_plist || return 1
  start_agent || return 1
  sleep 0.25
  live="$(running_version)"
  if [[ -n "$bundled" && "$live" == "$bundled" ]]; then
    print -P "${c_green}修复完成。当前后台: $live${c_reset}"
    return 0
  fi
  print -P "${c_red}修复失败。当前后台: ${live:-unknown} / 安装包: ${bundled:-unknown}${c_reset}"
  print "请执行: lsof -nP -iTCP:8899 -sTCP:LISTEN"
  return 1
}

auto_upgrade_if_needed() {
  ensure_runtime || return 1
  if ! is_running; then return 0; fi
  local bundled running
  bundled="$(bundled_version)"
  running="$(running_version)"
  if [[ -n "$bundled" && -n "$running" && "$bundled" != "$running" ]]; then
    print -P "${c_yellow}检测到后台版本不一致:${c_reset} $running  →  $bundled"
    force_repair || return 1
    sleep 0.6
  fi
}

status_line() {
  if is_running; then
    local json pid version
    json="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/status" 2>/dev/null || true)"
    pid="$(printf "%s\n" "$json" | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')"
    version="$(printf "%s\n" "$json" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
    local bundled
    bundled="$(bundled_version)"
    print -P "状态: ${c_green}● Running${c_reset}   PID ${pid:-?}   ${version:-unknown}"
    print -P "API : ${c_dim}http://127.0.0.1:$PORT${c_reset}"
    if [[ -n "$bundled" && -n "$version" && "$bundled" != "$version" ]]; then
      print -P "${c_red}版本不一致:${c_reset} 当前后台 $version / 当前安装包 $bundled"
    fi
  else
    print -P "状态: ${c_red}● Stopped${c_reset}"
  fi
}

write_plist() {
  [[ -n "$NODE" ]] || return 1
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$SERVER</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG_FILE</string>
  <key>StandardErrorPath</key><string>$LOG_FILE</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin</string>
  </dict>
</dict>
</plist>
PLIST
  chmod 600 "$PLIST"
}

start_agent() {
  ensure_runtime || return 1
  if [[ -z "$NODE" ]]; then
    print -P "${c_red}没有找到 Node.js。${c_reset}"
    print "先安装 Node.js 18+，例如: brew install node"
    return 1
  fi
  if is_running; then print -P "${c_yellow}Agent 已经在运行。${c_reset}"; return 0; fi
  write_plist || return 1
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST" 2>/dev/null || true
  launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  for _ in {1..30}; do is_running && break; sleep 0.15; done
  if is_running; then
    print -P "${c_green}Agent 已启动。${c_reset}"
  else
    print -P "${c_red}启动失败。最后日志:${c_reset}"
    tail -n 30 "$LOG_FILE" 2>/dev/null || true
    return 1
  fi
}

stop_agent() {
  local live_pid
  live_pid="$(running_pid || true)"
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || launchctl unload "$PLIST" >/dev/null 2>&1 || true
  stop_legacy_agent
  if [[ -f "$PID_FILE" ]]; then
    local pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    [[ "$pid" =~ ^[0-9]+$ ]] && kill "$pid" >/dev/null 2>&1 || true
  fi
  [[ "$live_pid" =~ ^[0-9]+$ ]] && kill "$live_pid" >/dev/null 2>&1 || true
  for _ in {1..30}; do ! is_running && break; sleep 0.1; done
  if is_running; then
    [[ "$live_pid" =~ ^[0-9]+$ ]] && kill -9 "$live_pid" >/dev/null 2>&1 || true
    sleep 0.2
  fi
  if is_running; then print -P "${c_red}Agent 仍在运行。${c_reset}"; else print -P "${c_green}Agent 已停止。${c_reset}"; fi
}

restart_agent() { stop_agent; sleep 0.25; start_agent; }

show_key() {
  ensure_runtime || return 1
  if [[ ! -f "$KEY_FILE" ]]; then
    start_agent >/dev/null 2>&1 || true
    sleep .2
  fi
  if [[ -f "$KEY_FILE" ]]; then
    print
    print -P "${c_yellow}API Key（等同本机 Agent 控制凭据，不要发给别人）:${c_reset}"
    cat "$KEY_FILE"
    print
    if command -v pbcopy >/dev/null 2>&1; then cat "$KEY_FILE" | pbcopy; print -P "${c_green}已复制到剪贴板。${c_reset}"; fi
  else
    print -P "${c_red}API Key 尚未生成。${c_reset}"
  fi
}

show_logs() {
  touch "$LOG_FILE"
  print -P "${c_dim}Ctrl+C 返回菜单${c_reset}"
  tail -n 80 -f "$LOG_FILE"
}

open_folder() {
  mkdir -p "$HOME_DIR/plugins" "$HOME_DIR/sessions"
  open "$HOME_DIR" >/dev/null 2>&1 || true
}

install_sample_plugin() {
  mkdir -p "$HOME_DIR/plugins"
  local f="$HOME_DIR/plugins/system-info.js"
  if [[ -e "$f" ]]; then print -P "${c_yellow}示例插件已存在:${c_reset} $f"; return; fi
  cat > "$f" <<'JS'
module.exports = {
  name: 'system-info',
  description: '返回 Node 与操作系统基础信息，不执行 shell。',
  risk: 'allow',
  inputSchema: { type: 'object', properties: {} },
  async execute(args, ctx) {
    const os = require('os');
    return {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      hostname: os.hostname(),
      projectRoot: ctx.projectRoot || null
    };
  }
};
JS
  print -P "${c_green}已创建:${c_reset} $f"
  if is_running && [[ -f "$KEY_FILE" ]]; then
    curl -fsS -X POST -H "X-API-Key: $(cat "$KEY_FILE")" "http://127.0.0.1:$PORT/api/plugins/reload" >/dev/null 2>&1 || true
  fi
}


install_mcp() {
  ensure_runtime || return 1
  if [[ -z "$NPM" ]]; then
    print -P "${c_red}没有找到 npm。${c_reset}"
    return 1
  fi
  print -P "${c_yellow}安装可选 MCP SDK 到 ~/.relay-agent ...${c_reset}"
  cd "$HOME_DIR" || return 1
  if [[ ! -f package.json ]]; then
    cat > package.json <<'JSON'
{"name":"relay-agent-local","private":true,"version":"0.0.0"}
JSON
  fi
  "$NPM" install --omit=dev '@modelcontextprotocol/sdk@^1.30.0'
  if [[ $? -eq 0 ]]; then
    if [[ ! -f "$HOME_DIR/mcp.json" ]]; then
      cat > "$HOME_DIR/mcp.json" <<'JSON'
{
  "mcpServers": {}
}
JSON
    fi
    print -P "${c_green}MCP 支持已安装。${c_reset} 配置文件: $HOME_DIR/mcp.json"
    is_running && restart_agent >/dev/null 2>&1 || true
  fi
}


set_project_dir() {
  ensure_runtime || return 1
  if [[ -z "$NODE" ]]; then print -P "${c_red}没有找到 Node.js。${c_reset}"; return 1; fi
  print "输入 Agent 的项目绝对路径（例如 /Users/ming/AweBounce）:"
  read project_path
  if [[ -z "$project_path" ]]; then print "已取消。"; return 0; fi
  if [[ ! -d "$project_path" ]]; then print -P "${c_red}目录不存在:${c_reset} $project_path"; return 1; fi
  PROJECT_PATH="$project_path" "$NODE" <<'NODECFG'
const fs=require('fs'),path=require('path'),os=require('os');
const f=path.join(os.homedir(),'.relay-agent','config.json');
let c={};try{c=JSON.parse(fs.readFileSync(f,'utf8'))}catch{}
c.projectRoot=process.env.PROJECT_PATH;
fs.writeFileSync(f,JSON.stringify(c,null,2),{mode:0o600});
console.log('projectRoot =',c.projectRoot);
NODECFG
  is_running && restart_agent >/dev/null 2>&1 || true
}

ai_chat() {
  auto_upgrade_if_needed || return 1
  is_running || start_agent || return 1
  [[ -n "$NODE" ]] || { print -P "${c_red}没有找到 Node.js。${c_reset}"; return 1; }
  [[ -f "$KEY_FILE" ]] || { print -P "${c_red}找不到 Relay Agent 本机控制 Key。${c_reset}"; return 1; }
  local local_key
  local_key="$(cat "$KEY_FILE")"
  print -P "${c_blue}进入 Relay Agent 网页 AI 对话（兼容 cuckoo 工具协议）。${c_reset}"
  print -P "${c_dim}不会调用 DeepSeek API；消息通过 Tampermonkey 转发到你已登录的 DeepSeek 网页。${c_reset}"
  RELAY_AGENT_URL="http://127.0.0.1:$PORT" RELAY_AGENT_KEY="$local_key" RELAY_EXPECTED_VERSION="$(bundled_version)" "$NODE" "$CHAT_CLIENT"
}


set_execution_mode() {
  ensure_runtime || return 1
  [[ -n "$NODE" ]] || { print -P "${c_red}没有找到 Node.js。${c_reset}"; return 1; }
  print "选择执行模式:"
  print "  1) ask      - 高风险/未知工具需要审批"
  print "  2) auto_all - 普通工具全部自动执行（保留系统破坏级硬拒绝）"
  printf "选择: "
  read mode_choice
  local mode="ask"
  [[ "$mode_choice" == "2" ]] && mode="auto_all"
  MODE="$mode" "$NODE" <<'NODECFG'
const fs=require('fs'),path=require('path'),os=require('os');
const f=path.join(os.homedir(),'.relay-agent','config.json');
let c={};try{c=JSON.parse(fs.readFileSync(f,'utf8'))}catch{}
c.approvalMode=process.env.MODE;
fs.writeFileSync(f,JSON.stringify(c,null,2),{mode:0o600});
console.log('approvalMode =',c.approvalMode);
NODECFG
  is_running && restart_agent >/dev/null 2>&1 || true
}

menu() {
  auto_upgrade_if_needed || true
  while true; do
    header
    status_line
    print
    print "  1) 启动 Agent"
    print "  2) 停止 Agent"
    print "  3) 重启 Agent"
    print "  4) 显示并复制 API Key"
    print "  5) 查看实时日志"
    print "  6) 打开 ~/.relay-agent"
    print "  7) 安装示例插件"
    print "  8) 安装 MCP 支持（可选）"
    print "  9) 测试 API"
    print " 10) 设置 Agent 项目目录"
    print " 11) 通过 DeepSeek 网页对话（Relay 工具闭环）"
    print " 12) 强制修复 / 升级后台"
    print " 13) 切换执行模式（审批 / 全部自动执行）"
    print "  0) 退出"
    print
    printf "选择: "
    read choice
    print
    case "$choice" in
      1) start_agent ;;
      2) stop_agent ;;
      3) restart_agent ;;
      4) show_key ;;
      5) show_logs ;;
      6) open_folder ;;
      7) install_sample_plugin ;;
      8) install_mcp ;;
      9) curl -sS "http://127.0.0.1:$PORT/api/status" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(s),null,2))}catch{console.log(s)}})' ;;
      10) set_project_dir ;;
      11) ai_chat ;;
      12) force_repair ;;
      13) set_execution_mode ;;
      0) exit 0 ;;
      *) print -P "${c_yellow}无效选项。${c_reset}" ;;
    esac
    print
    print -P "${c_dim}按 Enter 继续…${c_reset}"
    read _
  done
}

# 支持终端参数，也支持 Finder 双击菜单。
case "${1:-menu}" in
  start) start_agent ;;
  stop) stop_agent ;;
  restart) restart_agent ;;
  status) status_line ;;
  key) show_key ;;
  logs) show_logs ;;
  install) ensure_runtime && write_plist && print "Installed runtime: $SERVER" ;;
  repair|upgrade) force_repair ;;
  menu|*) menu ;;
esac
