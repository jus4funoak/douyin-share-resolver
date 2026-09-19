#!/usr/bin/env bash
# 启动批量转写服务。
#
# 所有路径都有默认值，直接 ./start.sh 即可，不需要先 export 任何东西。
# 想覆盖时用环境变量：PORT=9000 ./start.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# ── 可覆盖的默认配置 ─────────────────────────────────────────
PORT="${PORT:-8848}"
# 产出根目录：队列状态 + 运行参数 + 文字稿(out/)
DATA_DIR="${DY_ASR_DATA:-$ROOT/data}"
# ASR 临时中转目录（ffmpeg 转码、VAD 切片），别指向只有几十 MB 的 /tmp
ASR_TMP="${ASR_TMP:-/home/ssh/apps/asr-cpu/tmp}"
LOG_DIR="$ROOT/logs"

# ── 找 node：优先 PATH 里的，没有再回退 WorkBuddy 内置版本 ──
pick_node() {
  if [ -n "${NODE_BIN:-}" ] && [ -x "$NODE_BIN" ]; then echo "$NODE_BIN"; return; fi
  if command -v node >/dev/null 2>&1; then command -v node; return; fi
  local c
  for c in /home/ssh/.workbuddy/binaries/node/versions/*/bin/node; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  echo ""
}
NODE="$(pick_node || true)"
if [ -z "$NODE" ]; then
  echo "找不到 node，请先安装 Node 18+，或用 NODE_BIN=/path/to/node 指定"
  exit 1
fi

port_alive() {
  # 必须校验响应体：某些环境里有 HTTP 代理，连不存在的端口也会返回 502，
  # 此时 curl 退出码是 0，只看退出码会误判成「服务已在运行」。
  # --noproxy 绕过可能存在的 http_proxy/https_proxy。
  local out
  out="$(curl -sS --noproxy '*' --max-time 3 \
         "http://127.0.0.1:${PORT}/health" 2>/dev/null || true)"
  case "$out" in
    *'"status":"ok"'*|*'"ok":true'*) return 0 ;;
  esac
  return 1
}
port_pid() {
  local p=""
  if [ -z "$p" ]; then p="$(lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null | head -1 || true)"; fi
  if [ -z "$p" ]; then p="$(ss -ltnp 2>/dev/null | grep ":${PORT} " | grep -oP 'pid=\K[0-9]+' | head -1 || true)"; fi
  if [ -z "$p" ]; then p="$(fuser "${PORT}/tcp" 2>/dev/null | tr -d ' ' | cut -d/ -f1 | head -1 || true)"; fi
  if [ -z "$p" ]; then p="$(pgrep -f "node .*src/server\.js" 2>/dev/null | head -1 || true)"; fi
  if [ -z "$p" ]; then p="$(ps -eo pid,cmd 2>/dev/null | grep "[s]rc/server\.js" | awk '{print $1}' | head -1 || true)"; fi
  printf '%s' "$p"
}

# ── 已经在跑就别重复起 ──
if port_alive; then
  echo "服务已在运行：http://127.0.0.1:$PORT/batch  (pid $(port_pid || true))"
  echo "要重启请先执行 ./stop.sh"
  exit 0
fi

mkdir -p "$LOG_DIR" "$DATA_DIR/out" "$ASR_TMP"

export DY_ASR_DATA="$DATA_DIR"
export ASR_TMP="$ASR_TMP"
export PORT="$PORT"
export NODE_NO_WARNINGS=1

# setsid 让进程脱离终端会话，关掉终端也不会被 SIGHUP 带走
setsid "$NODE" src/server.js >> "$LOG_DIR/server.log" 2>&1 &

# setsid 会 fork，这里的 $! 不是真正的进程号，用端口/pgrep 反查
PID=""
for _ in $(seq 1 40); do
  sleep 0.25
  PID="$(port_pid || true)"
  [ -n "$PID" ] && break
done

if [ -z "$PID" ]; then
  # 进程可能还没开始监听，但确实起来了
  sleep 1
  if port_alive; then
    PID="$(pgrep -f "src/server\.js" 2>/dev/null | head -1 || true)"
  fi
fi

if [ -z "$PID" ]; then
  echo "启动失败，日志尾部："
  tail -20 "$LOG_DIR/server.log"
  exit 1
fi

# 拿到的 pid 可能属于别的命名空间（容器里常见），校验一下再展示
PID_LABEL="未知（进程不在本命名空间，不影响使用）"
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then PID_LABEL="$PID"; fi
[ -n "$PID" ] && echo "$PID" > "$LOG_DIR/server.pid"

cat <<EOF

  批量转写已启动
    页面     http://127.0.0.1:$PORT/batch
    单条解析 http://127.0.0.1:$PORT/
    停止     ./stop.sh

  产出目录   $DATA_DIR
    ├─ out/        文字稿 .txt 与元信息 .json
    ├─ queue.json  队列状态，重启后自动续跑
    └─ config.json 并发数 / 线程数等运行参数

  日志       $LOG_DIR/server.log
  进程号     $PID_LABEL
EOF
