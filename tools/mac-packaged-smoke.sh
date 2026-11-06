#!/bin/bash
# Пакетный смоук на настоящем маке (CI-раннер): установка как у юзера —
# DMG -> /Applications, карантин -> xattr -cr (ровно путь из гайда), запуск
# через LaunchServices, проверки ЖИВОГО приложения снаружи:
#   GET /                  — статика webk (окно открылось и загрузилось)
#   diag -> токен -> api/status — версия, процесс движка
#   POST api/probe         — живые фронты (вся цепочка DoH+TLS до Telegram)
#   pgrep + порты 1443/1080 — движок слушает
# Скриншот экрана — артефактом (best effort: на раннере может не быть прав).
#
# Отличие от npm run smoke: тот гоняет Electron из репозитория, здесь —
# собранный и установленный пакет, тот самый, что скачает юзер.
#
# Запуск: tools/mac-packaged-smoke.sh <путь к dmg> <ожидаемая версия> <скриншот>
set -uo pipefail

DMG="${1:?нужен путь к dmg}"
EXPECT_VER="${2:-}"
SHOT="${3:-packaged-smoke-macos.png}"
APP="Fortochka"
APPDIR="/Applications/$APP.app"
WEB="http://127.0.0.1:1081"

fail() {
  echo "PACKAGED_FAIL: $*"
  echo '--- tgws.log (хвост) ---'
  tail -20 "$HOME/Library/Application Support/fortochka/tgws.log" 2>/dev/null || true
  exit 1
}

# 0) чистый старт: убрать прежние копии
osascript -e "quit app \"$APP\"" >/dev/null 2>&1 || true
pkill -x "$APP" 2>/dev/null || true
sleep 1
rm -rf "$APPDIR"

# 1) установка как у юзера: смонтировать DMG, скопировать .app в /Applications
MOUNT=$(hdiutil attach -nobrowse -readonly "$DMG" | sed -n 's/.*\(\/Volumes\/.*\)$/\1/p' | tail -1)
[ -n "$MOUNT" ] || fail "DMG не смонтировался"
SRC=$(find "$MOUNT" -maxdepth 2 -name "$APP.app" 2>/dev/null | head -1)
[ -n "$SRC" ] || { hdiutil detach "$MOUNT" -quiet 2>/dev/null; fail ".app не найден в DMG"; }
ditto "$SRC" "$APPDIR"
hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
[ -d "$APPDIR" ] || fail "копирование в /Applications не удалось"
echo "установлен: $APPDIR"

# 2) путь из гайда: у скачанного файла карантин -> xattr -cr
xattr -w com.apple.quarantine "0081;$(date +%s);GitHub Actions;" "$APPDIR" 2>/dev/null \
  && echo "карантин выставлен (имитация скачивания)" \
  || echo "выставить карантин не удалось (не критично)"
xattr -cr "$APPDIR"
if xattr -p com.apple.quarantine "$APPDIR" >/dev/null 2>&1; then
  fail "xattr -cr не снял карантин"
else
  echo "xattr -cr: карантин снят"
fi

# 3) запуск как клик по иконке (LaunchServices), ждём локальную статику
T0=$(date +%s)
open "$APPDIR" || fail "open вернул ошибку"
UP=""
for i in $(seq 1 60); do
  if curl -fsS "$WEB/" 2>/dev/null | grep -q 'Telegram Web'; then UP=1; break; fi
  sleep 1
done
[ -n "$UP" ] || fail "статика не ответила за 60с — main упал или окно не загрузилось"
echo "время до окна: $(( $(date +%s) - T0 ))с"

# 4) diag API живого приложения: токен из страницы, статус по нему
TOKEN=$(curl -fsS "$WEB/fortochka/diag" 2>/dev/null | grep -oE '[0-9a-f]{24}' | head -1)
[ -n "$TOKEN" ] || fail "токен diag не найден на странице"
STATUS=$(curl -fsS -H "x-fortochka-token: $TOKEN" "$WEB/fortochka/api/status" 2>/dev/null) \
  || fail "api/status не ответил"
echo "$STATUS" | head -c 400; echo
echo "$STATUS" | grep -q '"running":true' || fail "движок не запущен (tgws.running=false)"
if [ -n "$EXPECT_VER" ]; then
  echo "$STATUS" | grep -q "\"version\":\"$EXPECT_VER\"" || fail "версия в приложении не $EXPECT_VER"
fi
echo "api/status: движок запущен, версия ок"

# 5) процесс и порты движка
pgrep -f tg-ws-proxy-macos >/dev/null || fail "процесс tg-ws-proxy-macos не найден"
nc -z 127.0.0.1 1443 2>/dev/null || fail "порт 1443 (MTProto) не слушается"
nc -z 127.0.0.1 1080 2>/dev/null || fail "порт 1080 (SOCKS) не слушается"
echo "движок: процесс жив, 1443/1080 слушаются"

# 6) фронты живые: DoH + health-check изнутри установленного приложения
PROBE=$(curl -fsS -X POST -H "x-fortochka-token: $TOKEN" "$WEB/fortochka/api/probe" 2>/dev/null) \
  || fail "api/probe не ответил"
echo "$PROBE" | grep -q '"alive":true' || fail "ни одного живого фронта"
ALIVE=$(echo "$PROBE" | grep -o '"alive":true' | wc -l | tr -d ' ')
TOTAL=$(echo "$PROBE" | grep -o '"host"' | wc -l | tr -d ' ')
echo "фронты живые: $ALIVE из $TOTAL"

# 7) скриншот экрана — артефактом (не обязан работать: TCC на раннере)
screencapture -x "$SHOT" >/dev/null 2>&1 || true
if [ -s "$SHOT" ]; then
  echo "скриншот: $SHOT ($(stat -f%z "$SHOT") байт)"
else
  echo "скриншот не удался (не критично)"
fi

# 8) выход
osascript -e "quit app \"$APP\"" >/dev/null 2>&1 || true
echo "PACKAGED_OK"
