#!/usr/bin/env bash
# 停止批量转写服务。
#
# 定位进程用多种手段依次尝试（不同系统上 ss -p / lsof 可能无权读取），
# 全都失败时也能给出明确的手动处理提示，不会假装成功。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PORT="${PORT:-8848}"
PID_FILE="$ROOT/logs/server.pid"

# 端口是否在响应。比查 pid 更可靠。
port_alive() {
  # 必须校验响应体：某些环境里有 HTTP 代理，连不存在的端口也会返回 502，
  # 此时 curl 退出码是 0，只看退出码会误判成「服务还在」。
  # --noproxy 绕过可能存在的 http_proxy/https_proxy。
  local out
  out="$(curl -sS --noproxy '*' --max-time 3 \
         "http://127.0.0.1:${PORT}/health" 2>/dev/null || true)"
  case "$out" in
    *'"status":"ok"'*|*'"ok":true'*) return 0 ;;
  esac
  return 1
}

# 依次用 lsof → ss → fuser → pgrep 找监听该端口的进程
port_pid() {
  local p=""
  if [ -z "$p" ]; then p="$(lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null | head -1 || true)"; fi
  if [ -z "$p" ]; then p="$(ss -ltnp 2>/dev/null | grep ":${PORT} " | grep -oP 'pid=\K[0-9]+' | head -1 || true)"; fi
  if [ -z "$p" ]; then p="$(fuser "${PORT}/tcp" 2>/dev/null | tr -d ' ' | cut -d/ -f1 | head -1 || true)"; fi
  if [ -z "$p" ]; then p="$(pgrep -f "node .*src/server\.js" 2>/dev/null | head -1 || true)"; fi
  if [ -z "$p" ]; then p="$(ps -eo pid,cmd 2>/dev/null | grep "[s]rc/server\.js" | awk '{print $1}' | head -1 || true)"; fi
  printf '%s' "$p"
}

# ── 首选：让服务自己优雅退出（查不到 pid 时也一定有效）──
if port_alive; then
  curl -sS --max-time 3 -X POST "http://127.0.0.1:${PORT}/api/shutdown" -o /dev/null
  for _ in $(seq 1 24); do
    sleep 0.25
    if ! port_alive; then
      rm -f "$PID_FILE"
      echo "已停止（优雅退出，端口 $PORT 已释放）"
      exit 0
    fi
  done
else
  rm -f "$PID_FILE"
  echo "端口 $PORT 上没有运行中的服务"
  exit 0
fi

# ── 兜底：优雅退出没生效，才动刀 ──
PID="$(port_pid || true)"

# 端口查不到就退一步用 pid 文件：覆盖了「服务已起但还没开始监听」的情况
if [ -z "$PID" ] && [ -f "$PID_FILE" ]; then
  OLD="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then PID="$OLD"; fi
fi

echo "优雅退出没生效，改用信号。"

if [ -z "$PID" ]; then
  echo "而且查不到进程号（受限环境里 lsof / ss -p / pgrep 都会失联）。"
  echo "剩下的办法是手动找："
  echo "  ss -ltnp | grep $PORT      # 找 pid= 后面的数字"
  echo "  ps aux | grep '[s]erver.js'"
  echo "  kill <pid>"
  exit 1
fi

# 先礼后兵：SIGTERM 让它走完清理，5 秒内不退出再 SIGKILL
kill "$PID" 2>/dev/null || true
for _ in $(seq 1 20); do
  sleep 0.25
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
done
if kill -0 "$PID" 2>/dev/null; then
  echo "进程 $PID 未响应 SIGTERM，强制结束"
  kill -9 "$PID" 2>/dev/null || true
  sleep 0.5
fi

rm -f "$PID_FILE"
echo "已停止（pid $PID）"
