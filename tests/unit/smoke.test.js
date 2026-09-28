'use strict';
// S6: оффлайн-часть смоука — выбор пары «аудио ↔ транскрипт» и метрика similarity.
// Гоняется без ключа и без сети; live-часть (сама расшифровка) — ручной прогон на хосте.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalize, similarity, pickPair, MAX_PAIR_DELTA_SEC, SIMILARITY_THRESHOLD } = require('../../scripts/speech-smoke.cjs');

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-pair-'));
  const base = Date.now() / 1000 - 600;
  for (const [name, { mtime, bytes }] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, bytes || 'x');
    fs.utimesSync(p, mtime, mtime);
  }
  return { dir, base };
}

const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(32, 7)]);

const BASE = Date.now() / 1000 - 600;

test('пара выбирается как аудио с наибольшим mtime ≤ mtime транскрипта', () => {
  const { dir } = fixture({
    'aaa-audio.ogg': { mtime: BASE - 30, bytes: OGG },
    'bbb-audio.ogg': { mtime: BASE - 0.3, bytes: OGG },
    'ccc-audio.ogg': { mtime: BASE + 5, bytes: OGG },
    'ddd-transcript-1.txt': { mtime: BASE, bytes: 'привет мир' },
  });
  const pair = pickPair(dir);
  assert.equal(pair.error, undefined, JSON.stringify(pair));
  assert.equal(pair.audio, 'bbb-audio.ogg', 'выбрано ближайшее аудио ПЕРЕД транскриптом');
  assert.ok(pair.deltaSec >= 0 && pair.deltaSec < MAX_PAIR_DELTA_SEC, `Δ=${pair.deltaSec}s`);
});

test('нет пары → объяснимая ошибка (не «зелёный» и не подгонка)', () => {
  const onlyAudio = fixture({ 'aaa-audio.ogg': { mtime: 1, bytes: OGG } });
  assert.match(pickPair(onlyAudio.dir).error, /-transcript-/);
  const onlyTxt = fixture({ 'ddd-transcript-1.txt': { mtime: 1, bytes: 'x' } });
  assert.match(pickPair(onlyTxt.dir).error, /-audio\./);
  const audioAfter = fixture({
    'aaa-audio.ogg': { mtime: 100, bytes: OGG },
    'ddd-transcript-1.txt': { mtime: 5, bytes: 'x' },
  });
  assert.match(pickPair(audioAfter.dir).error, /mtime/);
});

test('нормализация снимает регистр/пунктуацию/пробелы', () => {
  assert.equal(normalize('  Привет,   МИР!  '), 'привет мир');
});

test('метрика различает совпадение и чужой текст (не «зелёная всегда»)', () => {
  const ref = 'Привет это тестовое голосовое сообщение для песочницы';
  const mutated = 'Привет!  Это тестовое голосовое сообщение, для песочницы.';
  assert.ok(similarity(mutated, ref) >= SIMILARITY_THRESHOLD, 'слегка иной текст должен проходить');
  assert.ok(similarity('совершенно другой текст про погоду и кошек', ref) < SIMILARITY_THRESHOLD, 'чужой текст не должен проходить');
});
