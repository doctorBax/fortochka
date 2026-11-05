'use strict';
/*
 * Патчит собранные webk-воркеры (webapp/index.worker-*.js):
 *
 * 1) Вшитый массив фронтов -> живой: importScripts('/fortochka/fronts.js'),
 *    который отдаёт ранжированный health-check'ом список. Фолбэк — вшитый
 *    массив (если локальный сервер вдруг не ответил).
 *
 * 2) Суффикс медиа-сокетов. webk строит сабдомен по режиму соединения:
 *      it(mode) = mode === 'client' ? '' : '-1'
 *    т.е. upload/download едут на kws{dc}-1.<фронт>. У официального
 *    web.telegram.org wildcard-DNS, поэтому в браузере это работает, а у
 *    фронтов сообщества записей kws*-1 нет (NXDOMAIN) — весь медиа-трафик
 *    умирал на DNS, текст при этом работал. Патч режет суффикс: медиа едет
 *    по тем же kws{dc}.<фронт>, что и текст.
 *
 * Идемпотентен: каждый патч применяется один раз, повторный запуск ничего
 * не меняет. Запуск: node tools/patch-worker-fronts.js
 */
const fs = require('fs');
const path = require('path');

const WEBAPP = path.join(__dirname, '..', 'webapp');
const MARK = '__fortochkaFronts';

const files = fs.readdirSync(WEBAPP).filter((f) => /^index\.worker-.*\.js$/.test(f) && !f.endsWith('.map'));
if (!files.length) {
  console.error('worker-бандлы не найдены в ' + WEBAPP);
  process.exit(1);
}

for (const f of files) {
  const file = path.join(WEBAPP, f);
  let src = fs.readFileSync(file, 'utf8');

  // 1) живой список фронтов
  if (src.includes(MARK)) {
    console.log(f + ': фронты уже пропатчены, пропуск');
  } else {
    const m = src.match(/\[\`pclead\.co\.uk\`(?:,\`[a-z0-9.-]+\`)+\]/);
    if (!m) {
      console.error(f + ': вшитый список фронтов не найден — бандл пересобирался?');
      process.exit(1);
    }
    const replacement =
      '(()=>{try{importScripts("/fortochka/fronts.js")}catch(e){}' +
      'return self.' + MARK + '&&self.' + MARK + '.length?self.' + MARK + ':0})()' +
      '||' + m[0];
    src = src.replace(m[0], replacement);
    console.log(f + ': список фронтов -> importScripts');
  }

  // 2) медиа-суффикс: было `${...}ws${r}${i}`, стало `${...}ws${r}`
  const sufRe = /toLowerCase\(\)\}ws\$\{(\w+)\}\$\{(\w+)\}/;
  // самопочинка состояния после кривой замены `ws$r` (без скобок — литерал в шаблоне)
  const brokenRe = /toLowerCase\(\)\}ws\$(\w+)`/;
  if (sufRe.test(src)) {
    const hits = src.match(new RegExp(sufRe.source, 'g')).length;
    if (hits !== 1) {
      console.error(f + ': паттерн суффикса найден ' + hits + ' раз (ожидался 1) — правка вручную');
      process.exit(1);
    }
    src = src.replace(sufRe, 'toLowerCase()}ws$${$1');
    console.log(f + ': медиа-суффикс -1 убран (kws{dc}-1 -> kws{dc})');
  } else if (brokenRe.test(src)) {
    src = src.replace(brokenRe, 'toLowerCase()}ws${$1}`');
    console.log(f + ': починена кривая замена (ws$r -> ws${r})');
  } else if (/toLowerCase\(\)\}ws\$\{\w+\}`/.test(src)) {
    console.log(f + ': суффикс уже убран, пропуск');
  } else {
    console.error(f + ': строитель сабдомена не найден — бандл пересобирался?');
    process.exit(1);
  }

  fs.writeFileSync(file, src);
}
console.log('done');
