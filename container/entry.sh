#!/bin/sh
set -e
export DISPLAY=:99

# 前回のロックが残っていると Xvfb が起動しない（停止して再開したときに起きた）。
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
XVFB_PID=$!

# X が上がるまで待つ（上限を決めて回す）。
i=0
while [ "$i" -lt 100 ]; do
  xdotool getdisplaygeometry >/dev/null 2>&1 && break
  i=$((i + 1)); sleep 0.1
done

openbox &
OPENBOX_PID=$!

# ブラウザを画面つきで起動する。エージェントは画面（撮った画像と座標）から操作する。
# 最初の起動に付いてくる案内は出さない（画面を操作する側の邪魔になる）。
chromium \
  --no-first-run \
  --no-default-browser-check \
  --window-size=1280,800 \
  --window-position=0,0 \
  about:blank &
CHROMIUM_PID=$!

# VNC はコンテナの中の loopback にだけ開く。
x11vnc -display :99 -forever -shared -nopw -localhost -rfbport 5900 -quiet &
X11VNC_PID=$!

websockify --web /usr/share/novnc 6080 127.0.0.1:5900 &
WEBSOCKIFY_PID=$!

# 停止は SIGTERM で来る。wait は子プロセスへシグナルを渡さないので、ここで止める。
# これが無いと podman stop が 10 秒待ってから SIGKILL し、停止のたびに待たされる。
trap 'kill $XVFB_PID $OPENBOX_PID $CHROMIUM_PID $X11VNC_PID $WEBSOCKIFY_PID 2>/dev/null; exit 0' TERM INT

wait
