#!/usr/bin/env node
'use strict';
// Живой смоук приёмки Ф0 (docs/user-scenarios/speech/01-speech-transcribe.md, шаг 4):
// берёт реальную пару «аудио ↔ транскрипт» из media/intake, распознаёт аудио через
// speech_transcribe и сверяет с уже лежащим транскриптом.
//
// Пара на диске: шлюз trained-assist-tg-bot называет файлы
// sha256(chat.id:message_id:file_unique_id[:suffix]) — у аудио suffix='', у транскрипта
// suffix='transcript', общего префикса НЕТ. Правило пары: аудио с наибольшим mtime
// ≤ mtime транскрипта; Δ > 5 с или отсутствие кандидата — падаем с объяснением, а не
// «подгоняем» пару.
//
// Оффлайн (без ключа) проверяет выбор пары и метрику; live (нужен ключ профиля или
// разовый env DEEPGRAM_KEY) — саму расшифровку. Никакой ключ в файл не пишется.
//
//   node scripts/speech-smoke.cjs --intake ~/users/<id>/media/intake
//   DEEPGRAM_KEY=<key> node scripts/speech-smoke.cjs --intake <dir>   # разовый оверрайд
//   node scripts/speech-smoke.cjs --offline --intake <dir>            # только пара+метрика

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_PAIR_DELTA_SEC = 5;
const SIMILARITY_THRESHOLD = 0.9;

function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Токенный Dice: 2·|пересечение| / (|a|+|b|). Регистр/пунктуация/пробелы уже сняты.
function similarity(a, b) {
  const ta = normalize(a).split(' ').filter(Boolean);
  const tb = normalize(b).split(' ').filter(Boolean);
  if (!ta.length || !tb.length) return 0;
  const counts = new Map();
  for (const t of ta) counts.set(t, (counts.get(t) || 0) + 1);
  let common = 0;
  for (const t of tb) {
    const n = counts.get(t) || 0;
    if (n > 0) { common += 1; counts.set(t, n - 1); }
  }
  return (2 * common) / (ta.length + tb.length);
}

// → { audio, transcript, deltaSec } | { error }
function pickPair(dir) {
  const entries = fs.readdirSync(dir).map((f) => ({
    f,
    mtime: fs.statSync(path.join(dir, f)).mtimeMs / 1000,
  }));
  const transcripts = entries.filter((e) => e.f.includes('-transcript-'));
  const audios = entries.filter((e) => e.f.includes('-audio.'));
  if (!transcripts.length) return { error: `в ${dir} нет файла -transcript- (транскрипта голосового)` };
  if (!audios.length) return { error: `в ${dir} нет файла -audio. (аудио голосового)` };
  const t = transcripts.slice().sort((a, b) => a.mtime - b.mtime)[0];
  const before = audios.filter((a) => a.mtime <= t.mtime);
  if (!before.length) return { error: `нет аудио с mtime ≤ mtime транскрипта (${t.f})` };
  const a = before.slice().sort((x, y) => y.mtime - x.mtime)[0];
  return { audio: a.f, transcript: t.f, deltaSec: Number((t.mtime - a.mtime).toFixed(3)) };
}

function candidateIntakeDirs() {
  const dirs = [];
  if (process.env.SPEECH_SMOKE_INTAKE) dirs.push(process.env.SPEECH_SMOKE_INTAKE);
  const users = process.env.USERS_DIR || path.join(os.homedir(), 'users');
  try {
    for (const u of fs.readdirSync(users)) dirs.push(path.join(users, u, 'media', 'intake'));
  } catch { /* нет users/ — не на этом хосте */ }
  return dirs.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

function parseArgs(argv) {
  const out = { intake: null, offline: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--intake' || argv[i] === '-i') out.intake = argv[++i];
    else if (argv[i] === '--offline') out.offline = true;
  }
  return out;
}

function fail(msg) {
  console.error(`FAIL — ${msg}`);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let dir = args.intake;
  if (!dir) {
    const found = candidateIntakeDirs();
    if (!found.length) {
      fail('не нашёл media/intake. Передай --intake <папка> или SPEECH_SMOKE_INTAKE=<папка>. ' +
        'На этом хосте intake нет — смоук запускается там, где работает шлюз голосовых.');
    }
    dir = found[0];
  }
  if (!fs.existsSync(dir)) fail(`папки intake нет: ${dir}`);

  const pair = pickPair(dir);
  if (pair.error) fail(pair.error);
  if (!(pair.deltaSec >= 0 && pair.deltaSec <= MAX_PAIR_DELTA_SEC)) {
    fail(`пара подозрительная: Δ=${pair.deltaSec}s > ${MAX_PAIR_DELTA_SEC}s (аудио ${pair.audio} ↔ транскрипт ${pair.transcript})`);
  }
  const reference = fs.readFileSync(path.join(dir, pair.transcript), 'utf8');
  console.log(`Пара: ${pair.audio}  ↔  ${pair.transcript}   (Δ mtime ${pair.deltaSec}s)`);
  console.log(`Эталонный транскрипт: ${normalize(reference).length} символов (${reference.length} сырых)`);

  // Оффлайн-часть не требует ключа: метрика обязана отделять совпадение от чужого текста.
  const selfCheck = similarity(reference, reference);
  const wrongCheck = similarity(reference, 'совершенно другой текст про погоду и кошек');
  if (selfCheck < 1 - 1e-9) fail(`метрика сломана: similarity(эталон,эталон)=${selfCheck.toFixed(3)}`);
  if (wrongCheck >= SIMILARITY_THRESHOLD) fail(`метрика не различает тексты: чужой=${wrongCheck.toFixed(3)}`);
  console.log(`Метрика: эталон↔эталон=${selfCheck.toFixed(3)}, эталон↔чужой=${wrongCheck.toFixed(3)}`);

  const { readKey } = require('../src/deepgram/key-store');
  const key = readKey();
  if (args.offline || !key) {
    console.log(key ? 'Оффлайн-часть: OK (--offline)' : 'Оффлайн-часть: OK (ключа Deepgram нет — live пропущен)');
    console.log('SMOKE: PASS (оффлайн: только пара и метрика)');
    return;
  }

  const tools = require('../src/mcp-skills/tools/10-speech').tools;
  const res = await tools.speech_transcribe.handler({ source: path.join(dir, pair.audio), language: 'ru' });
  if (!res || res.error) fail(`speech_transcribe: ${res && res.error}${res && res.hint ? ' — ' + res.hint : ''}`);
  const sim = similarity(res.text, reference);
  console.log(`Распознано: ${normalize(res.text).length} символов`);
  console.log(`similarity = ${sim.toFixed(3)} (порог ${SIMILARITY_THRESHOLD})`);
  if (sim < SIMILARITY_THRESHOLD) {
    fail(`similarity ${sim.toFixed(3)} < ${SIMILARITY_THRESHOLD}. Порог НЕ понижаем молча — сначала разбираем причину в текстах.`);
  }
  console.log('SMOKE: PASS — реальное аудио распознано, совпадение с эталоном в норме.');
}

module.exports = { normalize, similarity, pickPair, parseArgs, candidateIntakeDirs, MAX_PAIR_DELTA_SEC, SIMILARITY_THRESHOLD };

if (require.main === module) {
  main().catch((e) => fail(String((e && e.message) || e)));
}
