# Fortochka

[README in English](README.md)

**Fortochka** — веб-клиент [Telegram Web K](https://github.com/morethanwords/tweb) (тот самый
красивый веб-телеграм) как настольное приложение, которое продолжает работать в сетях с
блокировками. Не браузер, не Telegram Desktop и без VPN.

Название — метафора: основное окно заколочено наглухо, а воздух идёт через форточку
(CF-фронт).

```
┌─ Electron ────────────────────────────────────────────────────────┐
│  UI:   статика webk на http://127.0.0.1:1081                      │
│        (localhost = secure context → service worker работает)     │
│  Сеть: session proxy Chromium → локальный HTTP CONNECT-шимм       │
│        allowlist (только Telegram-хосты) + DNS-over-HTTPS         │
└────────────────────────┬──────────────────────────────────────────┘
                         ▼
   wss://kws{dcId}.<фронт>/apiws  (живой список + health-check)
                         ▼
      Cloudflare ──► веб-эндпоинт Telegram (TLS end-to-end)
                         ▼
              Telegram DC (контент MTProto e2e)

Отдельно: вшитый tg-ws-proxy-rs (по платформам:
  vendor/tg-ws-proxy.exe / vendor/tg-ws-proxy-macos)
  ├─ MTProto :1443 — можно подключить и обычный Telegram Desktop
  └─ SOCKS5 :1080 — только Telegram, используется в smoke-тесте
```

## Почему работает там, где браузер не работает

1. **Живые CF-фонты сообщества** — домены `kws{dcId}.<фронт>`, проксирующие на веб-эндпоинты
   Telegram. Список **обновляется без релиза**: тянется из этого репозитория (`fronts.json`),
   новый домен доезжает до всех пользователей обычным PR.
2. **Health-check каждого фронта** — реальный WS-upgrade до `/apiws` (как делает сам клиент),
   ранжирование по латентности; при каждой ротации транспортов webk получает свежий порядок.
3. **DNS-over-HTTPS** — резолверы провайдера часто травят и Telegram-домены, и фронты; шимм
   резолвит сам, при неудаче — системный DNS.
4. **Только Telegram**: CONNECT-шимм пропускает хосты по allowlist (`*.telegram.org`, фронты,
   капча при логине) — скомпрометированный рендерер не сможет слить данные мимо Telegram.
   Локальная статика отдаётся со строгим CSP.

Подводный камень: `/apiws` требует WebSocket subprotocol `binary` — без него Telegram
отвечает 404.

## Установка

### Windows

Скачайте последний релиз в [Releases](../../releases): `fortochka-setup-<версия>.exe`
(установка в Program Files) или `fortochka-portable-<версия>.exe` (один файл, без установки).
Обновления автоматические (установщик); portable сообщает о новых релизах.

### macOS

Скачайте `fortochka-mac-<версия>.dmg` из [Releases](../../releases) — универсальная сборка
(Intel + Apple Silicon), откройте и перетащите **Fortochka** в **Applications**.

Сертификата Apple Developer ($99/год) нет, поэтому Gatekeeper остановит первый запуск.
Один раз снимите карантин в Терминале:

```
xattr -cr /Applications/Fortochka.app
```

(или правый клик по приложению → **Открыть** → **Открыть**). Дальше запускается как любое
другое приложение. На маке всё нативно: traffic lights в шапке, бейдж непрочитанных на
иконке в доке, ссылки `tg://`, Cmd+C/V/Q — но автообновления пока нет, поглядывайте на
[Releases](../../releases).

Меню трея: открыть, диагностика, автозапуск, выход. Закрытие окна прячет его; клик по
иконке в доке возвращает. Клик по ссылке `tg://` где угодно открывает её в Fortochka.

## Диагностика

Трей → **Диагностика**: локальная страница (`http://127.0.0.1:1081/fortochka/diag`) с живой
картой фронтов (латентность, источник списка), состоянием приложения и кнопками: перепроверить
фронты, проверить обновления, открыть лог движка / папку профиля.

```
npm run smoke    # безголовая проверка: статика + service worker + fronts + wss + SOCKS-бридж
```

## Настройки

Профиль — `%APPDATA%/fortochka/` (старый `tgweb-desktop` мигрирует автоматически).
`config.json` создаётся при первом запуске:

```jsonc
{
  "ports": { "web": 1081, "socks": 1080, "mtproto": 1443 },
  "fronts": {
    "autoUpdate": true,     // тянуть fronts.json из репо раз в 3 часа
    "list": null            // массив доменов — жёсткое перекрытие списка
  },
  "workerDomains": [],      // свой Cloudflare Worker, передаётся движку
  "doh": { "enabled": true, "urls": null },
  "security": { "allowHosts": [] },  // дополнительные хосты для CONNECT
  "window": { "startMinimized": false, "rememberBounds": true }
}
```

`state.json` (управляет приложение) хранит размер/позицию окна; `fronts-cache.json` — последний
рабочий список фронтов.

## Пересборка webk (опционально)

В `webapp/` лежит готовая пропатченная сборка. Из исходников:

```
git clone --depth 1 https://github.com/morethanwords/tweb.git
cd tweb && pnpm install --frozen-lockfile
# патч src/lib/mtproto/dcConfigurator.ts (ротация доменов фронтов)
pnpm exec vite build          # пишет в dist/, НЕ в public/!
# скопировать dist/* в webapp/, затем public/assets/* в webapp/assets/
node tools/patch-worker-fronts.js   # пере-применить патч живого списка в воркерах
```

## Сборка установщиков

```
npm install
npm run dist            # без подписи: release/fortochka-{setup,portable}-<версия>.exe
npm run dist:signed     # + переменная окружения WIN_CSC_KEY_PASSWORD=<пароль pfx>
npm run dist:mac        # на macOS (или в CI): release/fortochka-mac-<версия>.{zip,dmg}
```

macOS-сборку делает [.github/workflows/mac.yml](.github/workflows/mac.yml) (ручной запуск
на GitHub macos-раннере): собирает universal zip + dmg, прогоняет smoke-тест прямо там и
кладёт артефакты в релиз. Подпись ad-hoc (`identity: null`) — см. заметку про Gatekeeper выше.

`dist:signed` ждёт PFX в `build/codesign.pfx` (в git не попадает). Создайте самоподписанный
серт (`New-SelfSignedCertificate`, CodeSigning), экспортируйте в PFX, .cer импортируйте в
доверенные корни — тогда UAC покажет издателя. SmartScreen — отдельная история, его репутация
набирается скачиваниями.

## Модель угроз

**Что видит фронт (оператор домена + Cloudflare):** что ваш IP ходит в Cloudflare с SNI
фронтового домена; факт, время и объём WebSocket-трафика к `/apiws`; номер DC из заголовка
обфускации MTProto.

**Чего не видит:** содержимое сообщений — полезная нагрузка WebSocket зашифрована MTProto
end-to-end между клиентом и Telegram. Фронт пересылает шифротекст и может порвать соединение,
но не прочитать и не содержательно подменить его.

**Что делает сам Fortochka:** всё локально; шимм пускает только Telegram-хосты; никакой
телеметрии — наружу ходит только обновление списка фронтов (`fronts.json` из этого репо) и
проверка обновлений (GitHub Releases).

**Остаточное доверие:** фронтовые домены — комьюнити, они могут умирать и деградировать; это
риск живости, а не приватности — health-check автоматически обходит мёртвые. Свой фронт
(`workerDomains` в конфиге) убирает третью сторону полностью.

## Лицензии

- tweb (Telegram Web K): GPL-3.0 — https://github.com/morethanwords/tweb
- tg-ws-proxy-rs: MIT — https://github.com/valnesfjord/tg-ws-proxy-rs
- Эта обёртка: GPL-3.0-or-later ([LICENSE](LICENSE))
