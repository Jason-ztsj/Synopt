#!/usr/bin/env bash
# 同见：受"预检"保护的镜像构建。
# 教训：之前用 buildx --resource(cpuset/cpu-quota/memory)在 docker 驱动下会污染构建缓存，
# 把一个 COPY 层记成 0 字节，导致容器启动时 package.json 为空。所以这里不用 --resource，
# 改为【构建前健康检查】——系统忙/内存不足/过热就拒绝构建，这才是防"高载把 SSH 打崩"的有效手段。
#
# 用法:  ./build.sh
# 可覆盖:  LOAD_MAX=6  MEM_MIN_FREE_MB=2048  TEMP_MAX=78

set -euo pipefail
cd "$(dirname "$0")"

LOAD_MAX="${LOAD_MAX:-6}"                # 5 分钟负载上限(8 核机)
MEM_MIN_FREE_MB="${MEM_MIN_FREE_MB:-2048}"
TEMP_MAX="${TEMP_MAX:-78}"               # 最高热区温度上限(°C)

# ---- 预检 ----
load=$(awk '{print $1}' /proc/loadavg)
mem_free_mb=$(free -m | awk '/Mem:/{print $7}')
temp_milli=$(for z in /sys/class/thermal/thermal_zone*/temp; do [ -f "$z" ] && cat "$z"; done | sort -rn | head -1)
temp_c=$((temp_milli / 1000))
echo "预检: load5=$load  free=${mem_free_mb}MiB  temp=${temp_c}°C  | 阈值: load<$LOAD_MAX  free>${MEM_MIN_FREE_MB}MiB  temp<${TEMP_MAX}°C"

if awk "BEGIN{exit !($load > $LOAD_MAX)}"; then
  echo "✗ 拒绝构建: 5 分钟负载 $load 已高于 $LOAD_MAX,系统忙。稍后再试,或临时调高 LOAD_MAX。" >&2; exit 1
fi
if [ "$mem_free_mb" -lt "$MEM_MIN_FREE_MB" ]; then
  echo "✗ 拒绝构建: 可用内存 ${mem_free_mb}MiB 低于 ${MEM_MIN_FREE_MB}MiB。" >&2; exit 1
fi
if [ "$temp_c" -gt "$TEMP_MAX" ]; then
  echo "✗ 拒绝构建: 温度 ${temp_c}°C 高于 ${TEMP_MAX}°C,过热。" >&2; exit 1
fi
echo "预检通过。"

echo ">>> 构建 app + validator(串行,避免高载)"
docker compose build app validator

echo "✓ 构建完成。 上线: docker compose up -d --force-recreate"
