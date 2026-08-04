#!/bin/bash
# 코어 애니메이션의 실제 비용은 이 앱이 아니라 WindowServer 에서 난다. 그래서 앱 프로세스
# CPU 만 재면 "0%" 라는 오해를 사기 쉽다. 여기서는 shimmer 8개 + 점 8개를 켠 상태(on)와
# 끈 상태(off)를 번갈아 돌리며 WindowServer 의 누적 CPU 시간 차이를 잰다.
#
# 번갈아 재는 이유: 데스크톱에 다른 앱이 떠 있으면 WindowServer 바닥값이 30~40% 를 오가서,
# 한 번씩만 재면 그 흔들림에 신호가 묻힌다. off/on 을 교대로 여러 번 재면 느린 흐름은
# 상쇄되고 차이만 남는다.
#
#   bash bench/windowserver-delta.sh [반복횟수]

BIN=${BIN:-/tmp/shimmer-bench}
CYCLES=${1:-4}
WS=$(pgrep -x WindowServer)
[ -z "$WS" ] && { echo "WindowServer를 찾지 못했습니다"; exit 1; }

cpu_secs() {  # 누적 CPU 시간(초). ps 는 MM:SS.CC 로 준다.
  ps -o time= -p "$WS" | tr -d ' ' | awk -F: '{print $1*60 + $2}'
}

measure() {   # $1 = on|off  →  측정 구간 동안의 WindowServer CPU%
  "$BIN" --hold "$1" --seconds 9 >/dev/null 2>&1 &
  local pid=$!
  sleep 2                        # 창 생성 비용은 측정에서 뺀다
  local t0=$(cpu_secs) s0=$(date +%s)
  sleep 6
  local t1=$(cpu_secs) s1=$(date +%s)
  wait $pid
  echo "$t0 $t1 $s0 $s1" | awk '{printf "%.1f", ($2-$1)/($4-$3)*100}'
}

echo "WindowServer pid=$WS · ${CYCLES}회 교대 측정 (구간당 6초)"
on_sum=0; off_sum=0
for i in $(seq 1 "$CYCLES"); do
  off=$(measure off)
  on=$(measure on)
  echo "  #$i  off ${off}%   on ${on}%"
  off_sum=$(echo "$off_sum $off" | awk '{print $1+$2}')
  on_sum=$(echo "$on_sum $on" | awk '{print $1+$2}')
done
echo "$off_sum $on_sum $CYCLES" | awk '{printf "  평균 off %.1f%%   on %.1f%%   차이 %+.1f%%p\n", $1/$3, $2/$3, ($2-$1)/$3}'
