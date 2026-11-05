# Fortochka

[README in English](README.en.md)

Fortochka — настольная обёртка [Telegram Web K](https://github.com/morethanwords/tweb),
работающая в сетях, где веб-эндпоинты Telegram заблокированы. Название — от «форточки»:
прямой доступ заколочен провайдером, трафик идёт через маленькое открытое окно —
CF-фронты.

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

## Почему работает на заблокированных сетях

Прямой TCP до `*.web.telegram.org` режется. Fortochka:

1. Ходит через CF-фонты сообщества — домены `kws{dcId}.<фронт>`, проксирующие на
   веб-эндпоинты Telegram. Список тянется из этого репозитория (`fronts.json`): добавить
   фронт — это PR, а не релиз приложения.
2. Проверяет каждый фронт реальным WS-upgrade до `/apiws` (как делает сам клиент),
   сортирует по латентности и отдаёт webk свежий порядок при каждой ротации транспортов.
3. Резолвит DNS через DNS-over-HTTPS: резолверы провайдеров часто травят и
   Telegram-домены, и фронты. При неудаче — системный DNS.
4. Ходит только в Telegram. CONNECT-шимм пускает хосты по allowlist (`*.telegram.org`,
   фронты, капча при логине), локальная статика отдаётся со строгим CSP.
   Скомпрометированный рендерер не может слить данные мимо Telegram.

Нюанс: `/apiws` требует WebSocket subprotocol `binary` — без него Telegram отвечает 404.

## Установка

### Windows

Из [Releases](../../releases):

- `fortochka-setup-<версия>.exe` — установщик (Program Files), обновляется сам
- `fortochka-portable-<версия>.exe` — один файл, без установки

### macOS

Из [Releases](../../releases): `fortochka-mac-<версия>.dmg` (universal: Intel и
Apple Silicon). Откройте DMG, перетащите Fortochka в Applications.

Приложение не подписано сертификатом Apple, поэтому macOS заблокирует первый запуск —
обычно диалогом «повреждено и не может быть открыто, поместить в корзину» (macOS 14–15).
Приложение не повреждено: нажмите **Отмена** и один раз снимите карантин в Терминале
(Spotlight → «Терминал»):

```
xattr -cr /Applications/Fortochka.app
```

Если в Системные настройки → Конфиденциальность и безопасность появилась кнопка
**«Открыть в любом случае»** — можно ей, без Терминала. На macOS 13 и старше — правый
клик по приложению → **Открыть** → **Открыть**.

Пошаговый гайд со всеми вариантами и версиями macOS:
[docs/install-macos.md](docs/install-macos.md).

На macOS автообновления нет: приложение сообщит о новой версии (трей → проверить
обновления), DMG скачивается вручную.

На обеих платформах: закрытие окна прячет его; в меню иконки трея — открыть,
диагностика, автозапуск, выход. Ссылка `tg://`, открытая где угодно, открывается в
Fortochka. На macOS дополнительно: бейдж непрочитанных на иконке в доке и обычные
сокращения (Cmd+C/V/Q).

## Диагностика

Трей → **Диагностика**: локальная страница (`http://127.0.0.1:1081/fortochka/diag`) с
состоянием фронтов (латентность, источник списка), состоянием приложения и кнопками:
перепроверить фронты, проверить обновления, открыть лог движка / папку профиля.

```
npm run smoke    # безголовая проверка: статика + service worker + fronts + wss + SOCKS-бридж
```

## Настройки

Профиль — `%APPDATA%/fortochka/` на Windows, `~/Library/Application Support/fortochka/`
на macOS (старый `tgweb-desktop` мигрирует автоматически). `config.json` создаётся при
первом запуске:

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

`state.json` (управляет приложение) хранит размер/позицию окна; `fronts-cache.json` —
последний рабочий список фронтов.

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

`dist:signed` ждёт PFX в `build/codesign.pfx` (в git не попадает). Создайте
самоподписанный серт (`New-SelfSignedCertificate`, CodeSigning), экспортируйте в PFX,
.cer импортируйте в доверенные корни — тогда UAC покажет издателя. Репутация SmartScreen
отдельная история — набирается скачиваниями.

macOS-сборку делает [.github/workflows/mac.yml](.github/workflows/mac.yml) (ручной запуск
на GitHub macos-раннере): собирает universal zip + dmg, прогоняет smoke-тест на раннере и
кладёт артефакты в релиз. Подпись ad-hoc (`identity: null`) — см. заметку про установку
на macOS выше.

## Модель угроз

**Что видит фронт (оператор домена + Cloudflare):** что ваш IP ходит в Cloudflare с SNI
фронтового домена; факт, время и объём WebSocket-трафика к `/apiws`; номер DC из
заголовка обфускации MTProto.

**Чего не видит:** содержимое сообщений — полезная нагрузка WebSocket зашифрована MTProto
end-to-end между клиентом и Telegram. Фронт пересылает шифротекст и может порвать
соединение, но не прочитать и не содержательно подменить его.

**Что делает сам Fortochka:** всё локально; шимм пускает только Telegram-хосты; никакой
телеметрии — наружу ходит только обновление списка фронтов (`fronts.json` из этого репо)
и проверка обновлений (GitHub Releases).

**Остаточное доверие:** фронтовые домены — комьюнити, они могут умирать и деградировать;
это риск живости, а не приватности. Health-check автоматически обходит мёртвые. Свой
фронт (`workerDomains` в конфиге) убирает третью сторону полностью.

## Лицензии

- tweb (Telegram Web K): GPL-3.0 — https://github.com/morethanwords/tweb
- tg-ws-proxy-rs: MIT — https://github.com/valnesfjord/tg-ws-proxy-rs
- Эта обёртка: GPL-3.0-or-later ([LICENSE](LICENSE))
