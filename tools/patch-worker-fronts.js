'use strict';
/*
 * Патчит собранные webk-воркеры (webapp/index.worker-*.js): вшитый массив
 * фронтов заменяется на живой — importScripts('/fortochka/fronts.js'),
 * который отдаёт ранжированный health-check'ом список. Фолбэк — вшитый
 * массив (если локальный сервер вдруг не ответил).
 *
 * Идемпотентен: повторный запуск ничего не меняет.
 * Запуск: node tools/patch-worker-fronts.js
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
  if (src.includes(MARK)) {
    console.log(f + ': уже пропатчен, пропуск');
    continue;
  }
  // вшитый массив фронтов из патча dcConfigurator.ts (после минификации)
  const m = src.match(/\[\`pclead\.co\.uk\`(?:,\`[a-z0-9.-]+\`)+\]/);
  if (!m) {
    console.error(f + ': вшитый список фронтов не найден — бандл пересобирался?');
    process.exit(1);
  }
  const original = m[0];
  const replacement =
    '(()=>{try{importScripts("/fortochka/fronts.js")}catch(e){}' +
    'return self.' + MARK + '&&self.' + MARK + '.length?self.' + MARK + ':0})()' +
    '||' + original;
  src = src.replace(original, replacement);
  fs.writeFileSync(file, src);
  console.log(f + ': патч применён (' + original.length + ' байт списка -> importScripts)');
}
console.log('done');
