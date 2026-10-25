#!/bin/sh
# Eaon worker host: installs, updates or removes the host app on this computer.
#
#   sh install.sh               install (EAON_HOST_PORT, EAON_HOST_SECRET, EAON_HOST_NAME set by Eaon Desktop)
#   sh install.sh --update      swap in this package and restart (sent by Eaon Desktop over the link)
#   sh install.sh --uninstall   stop it and remove it (the workers' own folders stay)
#
# It lives in ~/.eaon-host: app/ (this package), runtime/ (Electron for this
# computer, downloaded once per version), data/ (the workers), host.json (port
# and link secret) and host.log. Lines starting "EAON:" are progress for the
# desktop to show; "EAON_HOST_READY" ends a good install, "EAON_ERROR:" a failed one.
set -eu

MODE=install
case "${1:-}" in
  --update) MODE=update ;;
  --uninstall) MODE=uninstall ;;
esac

HOST_HOME="${EAON_HOST_HOME:-$HOME/.eaon-host}"
# An update runs from inside the host, whose DISPLAY is its own Xvfb: that's no
# display to keep using once the host restarts, so it is decided afresh.
if [ -n "${EAON_HOST_XVFB:-}" ]; then unset DISPLAY XAUTHORITY EAON_HOST_XVFB; fi
PKG="$(cd "$(dirname "$0")" && pwd)"
LABEL=dev.eaon.host
UNIT=eaon-host

say() { echo "EAON: $*"; }
fail() {
  echo "EAON_ERROR: $*"
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }
# EAON_SUDO_PASS is the account's password, when the desktop was given one for SSH: it lets
# sudo install the libraries Electron needs on a computer where sudo asks for a password.
can_sudo() {
  [ "$(id -u)" = 0 ] && return 0
  have sudo || return 1
  sudo -n true 2>/dev/null && return 0
  [ -n "${EAON_SUDO_PASS:-}" ] && printf '%s\n' "$EAON_SUDO_PASS" | sudo -S -p '' true 2>/dev/null
}
as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"
  elif sudo -n true 2>/dev/null; then sudo -n "$@"
  else printf '%s\n' "${EAON_SUDO_PASS:-}" | sudo -S -p '' "$@"; fi
}

OS=$(uname -s)
ARCH=$(uname -m)
case "$OS" in
  Linux) PLAT=linux ;;
  Darwin) PLAT=darwin ;;
  *) fail "Eaon's worker host runs on Linux and macOS; this computer runs $OS." ;;
esac
case "$ARCH" in
  x86_64 | amd64) EARCH=x64 ;;
  aarch64 | arm64) EARCH=arm64 ;;
  armv7l | armv7*) EARCH=armv7l ;;
  *) EARCH="" ;;
esac

# ------------------------------------------------------------- the service

service_kind() { if [ -n "${KIND_WAS:-}" ]; then echo "$KIND_WAS"; else cat "$HOST_HOME/service" 2>/dev/null || echo none; fi; }

stop_service() {
  case "$(service_kind)" in
    system) as_root systemctl stop "$UNIT" 2>/dev/null || true ;;
    user) systemctl --user stop "$UNIT" 2>/dev/null || true ;;
    launchd)
      launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$HOME/Library/LaunchAgents/$LABEL.plist" 2>/dev/null || true
      ;;
    nohup)
      if [ -f "$HOST_HOME/host.pid" ]; then kill "$(cat "$HOST_HOME/host.pid")" 2>/dev/null || true; fi
      ;;
  esac
  # Whatever else is still running from here (an earlier install, a run by hand).
  if have pkill; then pkill -f "$HOST_HOME/app/eaon-host" 2>/dev/null || true; fi
}

remove_service() {
  case "$(service_kind)" in
    system)
      as_root systemctl disable "$UNIT" 2>/dev/null || true
      as_root rm -f "/etc/systemd/system/$UNIT.service" || true
      as_root systemctl daemon-reload 2>/dev/null || true
      ;;
    user)
      systemctl --user disable "$UNIT" 2>/dev/null || true
      rm -f "$HOME/.config/systemd/user/$UNIT.service"
      systemctl --user daemon-reload 2>/dev/null || true
      ;;
    launchd) rm -f "$HOME/Library/LaunchAgents/$LABEL.plist" ;;
    nohup)
      if have crontab; then (crontab -l 2>/dev/null | grep -v "$HOST_HOME/run.sh") | crontab - 2>/dev/null || true; fi
      ;;
  esac
  rm -f "${HOST_HOME:?}/service"
}

# ------------------------------------------------------------ the firewall

# Eaon Desktop connects in on the host's port, which a firewall that drops
# everything not allowed (ufw on a Raspberry Pi, firewalld on Fedora, macOS's)
# turns into a link that never answers. The link is encrypted and only opens
# for the desktop holding its key, so the port is opened like SSH's would be.
FIREWALL_HINT=""
sbin() { PATH="$PATH:/usr/sbin:/sbin" command -v "$1" 2>/dev/null; }
open_port() {
  if [ "$PLAT" = linux ]; then
    UFW=$(sbin ufw) || UFW=""
    FWCMD=$(sbin firewall-cmd) || FWCMD=""
    if [ -n "$UFW" ] && can_sudo && as_root "$UFW" status 2>/dev/null | grep -q '^Status: active'; then
      if as_root "$UFW" allow "$1/tcp" comment 'Eaon worker host' >/dev/null 2>&1; then
        say "Opened port $1 in this computer's firewall (ufw)"
      else FIREWALL_HINT="sudo ufw allow $1/tcp"; fi
    elif [ -n "$FWCMD" ] && can_sudo && [ "$(as_root "$FWCMD" --state 2>/dev/null)" = running ]; then
      if as_root "$FWCMD" --permanent --add-port="$1/tcp" >/dev/null 2>&1 && as_root "$FWCMD" --reload >/dev/null 2>&1; then
        say "Opened port $1 in this computer's firewall (firewalld)"
      else FIREWALL_HINT="sudo firewall-cmd --permanent --add-port=$1/tcp && sudo firewall-cmd --reload"; fi
    elif [ -n "$UFW$FWCMD" ] && ! can_sudo; then
      # Can't look without root; if one is on, this is what lets the desktop in.
      if [ -n "$UFW" ]; then FIREWALL_HINT="sudo ufw allow $1/tcp"; else FIREWALL_HINT="sudo firewall-cmd --permanent --add-port=$1/tcp && sudo firewall-cmd --reload"; fi
    fi
  elif [ "$PLAT" = darwin ]; then
    FW=/usr/libexec/ApplicationFirewall/socketfilterfw
    if [ -x "$FW" ] && "$FW" --getglobalstate 2>/dev/null | grep -q enabled; then
      if can_sudo && as_root "$FW" --add "$EBIN" >/dev/null 2>&1 && as_root "$FW" --unblockapp "$EBIN" >/dev/null 2>&1; then
        say "Let the host app through this Mac's firewall"
      else FIREWALL_HINT="sudo $FW --add '$EBIN' && sudo $FW --unblockapp '$EBIN'"; fi
    fi
  fi
  if [ -n "$FIREWALL_HINT" ]; then
    say "This computer has a firewall that may block Eaon Desktop. If it can't connect, run here: $FIREWALL_HINT"
  fi
}
close_port() {
  [ "$PLAT" = linux ] || return 0
  can_sudo || return 0
  UFW=$(sbin ufw) || UFW=""
  FWCMD=$(sbin firewall-cmd) || FWCMD=""
  if [ -n "$UFW" ]; then as_root "$UFW" delete allow "$1/tcp" >/dev/null 2>&1 || true; fi
  if [ -n "$FWCMD" ]; then
    as_root "$FWCMD" --permanent --remove-port="$1/tcp" >/dev/null 2>&1 && as_root "$FWCMD" --reload >/dev/null 2>&1 || true
  fi
}

if [ "$MODE" = uninstall ]; then
  # Unlinking in Eaon Desktop runs this from inside the service it removes, and
  # stopping the service ends this script too: so everything else goes first.
  say "Removing the worker host"
  KIND_WAS=$(service_kind)
  remove_service
  OLD_PORT=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$HOST_HOME/host.json" 2>/dev/null)
  [ -z "$OLD_PORT" ] || close_port "$OLD_PORT"
  rm -rf "${HOST_HOME:?}/app" "${HOST_HOME:?}/app.next" "${HOST_HOME:?}/app.old" "${HOST_HOME:?}/runtime" "${HOST_HOME:?}/run.sh" "${HOST_HOME:?}/host.json" "${HOST_HOME:?}/incoming.tgz" "${HOST_HOME:?}/uploads"
  # The keys are the desktop's (API keys, sign-ins): with no host left to use them, none stays on this disk.
  # A new install gets them from the desktop again.
  rm -f "${HOST_HOME:?}/data/keys.dat" "${HOST_HOME:?}/data/keys.dat".*
  say "Removed, with the keys it had from your desktop. The workers' data stays in $HOST_HOME/data and their folders in ~/Eaon/Workers."
  echo "EAON_HOST_REMOVED"
  stop_service
  exit 0
fi

[ -n "$EARCH" ] || fail "There is no Electron for this processor ($ARCH)."

# ----------------------------------------------------------- the package

ELECTRON_VERSION=$(sed -n 's/.*"electron": *"\([^"]*\)".*/\1/p' "$PKG/host-build.json")
[ -n "$ELECTRON_VERSION" ] || fail "The package is incomplete (no Electron version)."
mkdir -p "$HOST_HOME"
chmod 700 "$HOST_HOME"

if [ "$MODE" = install ]; then
  [ -n "${EAON_HOST_SECRET:-}" ] || fail "No link secret was given."
  PORT="${EAON_HOST_PORT:-3268}"
  NAME=$(printf '%s' "${EAON_HOST_NAME:-$(hostname)}" | tr -cd 'A-Za-z0-9 ._()-' | cut -c1-60)
  umask 077
  printf '{\n  "port": %s,\n  "secret": "%s",\n  "name": "%s"\n}\n' "$PORT" "$EAON_HOST_SECRET" "$NAME" >"$HOST_HOME/host.json"
  umask 022
else
  [ -f "$HOST_HOME/host.json" ] || fail "This computer isn't set up as a worker host yet."
  PORT=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$HOST_HOME/host.json")
fi

say "Copying the host app"
rm -rf "${HOST_HOME:?}/app.next"
if [ "$PKG" != "$HOST_HOME/app.next" ]; then cp -R "$PKG" "$HOST_HOME/app.next"; fi
APP_NEXT="$HOST_HOME/app.next"

# ------------------------------------------------------------- Electron

download() {
  if have curl; then curl -fL --retry 3 --connect-timeout 20 -s -o "$2" "$1"
  elif have wget; then wget -q -O "$2" "$1"
  else fail "Neither curl nor wget is installed."; fi
}

RUNTIME_DIR="$HOST_HOME/runtime/electron-$ELECTRON_VERSION-$PLAT-$EARCH"
if [ "$PLAT" = darwin ]; then EBIN="$RUNTIME_DIR/Electron.app/Contents/MacOS/Electron"; else EBIN="$RUNTIME_DIR/electron"; fi

if [ ! -x "$EBIN" ]; then
  say "Downloading Electron $ELECTRON_VERSION for $PLAT-$EARCH (about 100 MB)"
  ZIP="$HOST_HOME/runtime/electron-$ELECTRON_VERSION-$PLAT-$EARCH.zip"
  mkdir -p "$HOST_HOME/runtime"
  download "https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/electron-v$ELECTRON_VERSION-$PLAT-$EARCH.zip" "$ZIP" ||
    fail "Electron couldn't be downloaded. Is this computer online?"
  say "Unpacking Electron"
  rm -rf "${RUNTIME_DIR:?}.part"
  mkdir -p "$RUNTIME_DIR.part"
  if [ "$PLAT" = darwin ]; then ditto -x -k "$ZIP" "$RUNTIME_DIR.part"
  elif have unzip; then unzip -q -o "$ZIP" -d "$RUNTIME_DIR.part"
  elif have python3; then python3 -m zipfile -e "$ZIP" "$RUNTIME_DIR.part"
  elif have bsdtar; then bsdtar -xf "$ZIP" -C "$RUNTIME_DIR.part"
  else fail "Nothing here can unzip (install unzip)."; fi
  chmod +x "$RUNTIME_DIR.part/electron" "$RUNTIME_DIR.part/chrome_crashpad_handler" "$RUNTIME_DIR.part/chrome-sandbox" 2>/dev/null || true
  rm -rf "${RUNTIME_DIR:?}"
  mv "$RUNTIME_DIR.part" "$RUNTIME_DIR"
  rm -f "${ZIP:?}"
  # Older versions go, so updates don't pile up.
  for old in "$HOST_HOME"/runtime/electron-*; do
    [ "$old" = "$RUNTIME_DIR" ] || rm -rf "${old:?}"
  done
fi

# ------------------------------------------- what the browsers need on Linux

XVFB=""
if [ "$PLAT" = linux ]; then
  NEED=""
  if ldd "$EBIN" 2>/dev/null | grep -q "not found"; then NEED=libs; fi
  if [ -z "${DISPLAY:-}" ] && ! have xvfb-run; then NEED="$NEED xvfb"; fi
  if [ -n "$NEED" ]; then
    if have apt-get && can_sudo; then
      say "Installing what Electron needs on Linux (this takes a minute)"
      as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true
      for pkgs in libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgtk-3-0 libgbm1 "libasound2t64 libasound2" libxss1 libxshmfence1 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 libcairo2 xvfb xauth fonts-liberation; do
        for one in $pkgs; do
          if as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$one" >/dev/null 2>&1; then break; fi
        done
      done
    elif have dnf && can_sudo; then
      say "Installing what Electron needs on Linux (this takes a minute)"
      as_root dnf install -y -q nss atk at-spi2-atk cups-libs libdrm gtk3 mesa-libgbm alsa-lib libXScrnSaver xorg-x11-server-Xvfb >/dev/null 2>&1 || true
    else
      say "Some system libraries are missing and this account can't install them; workers here will work without a browser. To give them one, run: sudo apt-get install -y libnss3 libgtk-3-0 libgbm1 libasound2 xvfb xauth"
    fi
  fi
  if [ -z "${DISPLAY:-}" ] && have xvfb-run; then XVFB=1; fi
fi

run_electron() {
  if [ -n "$XVFB" ]; then xvfb-run -a -s "-screen 0 1280x900x24" "$EBIN" "$@"; else "$EBIN" "$@"; fi
}

say "Checking that workers' browsers work on this computer"
RUNTIME=node
FLAGS=""
NOTE=""
if [ "$PLAT" = linux ] && [ -z "$XVFB" ] && [ -z "${DISPLAY:-}" ]; then
  NOTE="This computer has no display and no Xvfb, so workers here work without a browser."
elif run_electron "$APP_NEXT/eaon-host.mjs" --smoke >"$HOST_HOME/smoke.log" 2>&1; then
  RUNTIME=electron
elif run_electron --no-sandbox "$APP_NEXT/eaon-host.mjs" --smoke >>"$HOST_HOME/smoke.log" 2>&1; then
  # Chromium's sandbox needs user namespaces, which some systems (Ubuntu 24.04) restrict.
  RUNTIME=electron
  FLAGS="--no-sandbox"
  say "Chromium's sandbox isn't available here, so browsers run without it."
else
  NOTE="Electron couldn't open a window on this computer (see $HOST_HOME/smoke.log), so workers here work without a browser."
fi
[ -z "$NOTE" ] || say "$NOTE"

# ------------------------------------------------------------ swap it in

# An update runs from inside the service it replaces, so it doesn't stop it
# first: it swaps the files under the running app and ends it at the very end.
[ "$MODE" = update ] || stop_service
rm -rf "${HOST_HOME:?}/app.old"
if [ -d "$HOST_HOME/app" ]; then mv "$HOST_HOME/app" "$HOST_HOME/app.old"; fi
mv "$APP_NEXT" "$HOST_HOME/app"
rm -rf "${HOST_HOME:?}/app.old" "${HOST_HOME:?}/incoming.tgz"

RUN="$HOST_HOME/run.sh"
{
  echo "#!/bin/sh"
  echo "# Written by install.sh; starts the Eaon worker host."
  echo "export EAON_HOST_HOME='$HOST_HOME'"
  echo "cd '$HOST_HOME'"
  if [ "$RUNTIME" = electron ]; then
    if [ -n "$XVFB" ]; then
      echo "export EAON_HOST_XVFB=1"
      echo "exec xvfb-run -a -s '-screen 0 1280x900x24' '$EBIN' $FLAGS '$HOST_HOME/app/eaon-host.mjs' >>'$HOST_HOME/host.log' 2>&1"
    else
      echo "exec '$EBIN' $FLAGS '$HOST_HOME/app/eaon-host.mjs' >>'$HOST_HOME/host.log' 2>&1"
    fi
  else
    echo "export EAON_HOST_BROWSER_NOTE='$(printf '%s' "$NOTE" | tr -d "'")'"
    echo "exec env ELECTRON_RUN_AS_NODE=1 '$EBIN' '$HOST_HOME/app/eaon-host-node.mjs' >>'$HOST_HOME/host.log' 2>&1"
  fi
} >"$RUN"
chmod 755 "$RUN"

# The log is kept short: the newest 2 MB.
if [ -f "$HOST_HOME/host.log" ] && [ "$(wc -c <"$HOST_HOME/host.log")" -gt 2000000 ]; then
  tail -c 1000000 "$HOST_HOME/host.log" >"$HOST_HOME/host.log.tmp" && mv "$HOST_HOME/host.log.tmp" "$HOST_HOME/host.log"
fi

if [ "$MODE" = update ]; then
  say "Restarting on the new version"
  if [ "$(service_kind)" = nohup ]; then
    stop_service
    nohup "$RUN" >/dev/null 2>&1 &
    echo $! >"$HOST_HOME/host.pid"
  elif have pkill; then
    # The service manager starts it again, from the new files.
    pkill -f "$HOST_HOME/app/eaon-host" || true
  else
    stop_service
  fi
  echo "EAON_HOST_UPDATED"
  exit 0
fi

say "Starting it, and making it start with the computer"
KIND=""
if [ "$PLAT" = linux ]; then
  if have systemctl && [ -d /run/systemd/system ] && can_sudo; then
    # Written here first: sudo may be reading its password from stdin.
    cat >"${HOST_HOME:?}/$UNIT.service" <<EOF
[Unit]
Description=Eaon worker host
Wants=network-online.target
After=network-online.target

[Service]
User=$(id -un)
Environment=HOME=$HOME
ExecStart=$RUN
Restart=always
RestartSec=5
KillMode=control-group

[Install]
WantedBy=multi-user.target
EOF
    as_root cp "${HOST_HOME:?}/$UNIT.service" "/etc/systemd/system/$UNIT.service"
    rm -f "${HOST_HOME:?}/$UNIT.service"
    as_root systemctl daemon-reload
    as_root systemctl enable "$UNIT" >/dev/null 2>&1
    as_root systemctl restart "$UNIT"
    KIND=system
  elif have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
    mkdir -p "$HOME/.config/systemd/user"
    cat >"$HOME/.config/systemd/user/$UNIT.service" <<EOF
[Unit]
Description=Eaon worker host

[Service]
ExecStart=$RUN
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable "$UNIT" >/dev/null 2>&1
    systemctl --user restart "$UNIT"
    # Keeps it running after logging out, and starts it at boot.
    loginctl enable-linger "$(id -un)" 2>/dev/null || say "It starts when you log in; to start it at boot, run: sudo loginctl enable-linger $(id -un)"
    KIND=user
  fi
elif [ "$PLAT" = darwin ]; then
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$RUN</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST" 2>/dev/null; then KIND=launchd; fi
fi
if [ -z "$KIND" ]; then
  # No service manager this account can use: run it now, and again at boot through cron.
  nohup "$RUN" >/dev/null 2>&1 &
  echo $! >"$HOST_HOME/host.pid"
  if have crontab; then (crontab -l 2>/dev/null | grep -v "$RUN"; echo "@reboot $RUN") | crontab - 2>/dev/null || true; fi
  KIND=nohup
fi
echo "$KIND" >"$HOST_HOME/service"
open_port "$PORT"

probe() {
  if have curl; then curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"
  elif have python3; then python3 -c "import socket,sys; socket.create_connection(('127.0.0.1', int(sys.argv[1])), 2)" "$PORT" 2>/dev/null
  else wget -q -O /dev/null -T 2 "http://127.0.0.1:$PORT/" 2>/dev/null || [ $? = 8 ]; fi
}
i=0
until probe; do
  i=$((i + 1))
  if [ "$i" -ge 90 ]; then
    tail -n 20 "$HOST_HOME/host.log" 2>/dev/null | sed 's/^/EAON: | /'
    fail "The host app didn't start. Its log is $HOST_HOME/host.log."
  fi
  sleep 1
done
echo "EAON_HOST_READY $PORT $PLAT $EARCH $RUNTIME"
