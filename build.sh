#!/usr/bin/env bash
# 同见：受限制的镜像构建。
# 用 buildx 的 --resource 绑定 RK3588 大核(Cortex-A76 = CPU 4-7)并限制总 CPU/内存，
# 避免在高载设备上跑 docker build 把系统打崩(SSH 断连那条教训)。构建前先做健康检查。
#
# 用法:  ./build.sh            # 构建 app + validator
#        CPUSET=4-7 CPU_QUOTA=600000 ./build.sh   # 自定义资源限制
# 说明:  compose build 不透传 --resource,所以这里用 docker buildx build 直接构建两个 target。

set -euo pipefail
cd "$(dirname "$0")"

# ---- 资源限制(可覆盖) ----
CPUSET="${CPUSET:-4-7}"                 # RK3588 大核(A76,2.4GHz)= CPU 4-7;小核(A55)= 0-3
CPU_QUOTA="${CPU_QUOTA:-600000}"        # µs/周期,100000 = 1 核;600000 = 最多 6 核(即总 8 核的 75%)
MEMORY="${MEMORY:-2g}"

# ---- 健康检查阈值(可覆盖) ----
LOAD_MAX="${LOAD_MAX:-6}"                # 5 分钟负载上限(8 核机;超过则拒绝)
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

echo ">>> 构建 app (target=app, 限定 cpuset=$CPUSET cpu-quota=$CPU_QUOTA mem=$MEMORY)"
docker buildx build \
  --target app \
  --resource "cpuset-cpus=$CPUSET" \
  --resource "cpu-quota=$CPU_QUOTA" \
  --resource "memory=$MEMORY" \
  --tag tongjian-video-mvp:local .

echo ">>> 构建 validator (target=validator, 限定 cpuset=$CPUSET cpu-quota=$CPU_QUOTA mem=$MEMORY)"
docker buildx build \
  --target validator \
  --resource "cpuset-cpus=$CPUSET" \
  --resource "cpu-quota=$CPU_QUOTA" \
  --resource "memory=$MEMORY" \
  --tag tongjian-video-validator:local .

echo "✓ 构建完成(资源已限制: cpuset=$CPUSET cpu-quota=$CPU_QUOTA mem=$MEMORY)。"
echo "  上线仍用: docker compose up -d --force-recreate"
