# CI этого скила

Правила домена: `trained-assist-agent/docs/domain-skill-repo-test-rules.md`
(обязательный минимум с 2026-09-28).

| Слой | Что проверяет | Команда |
|---|---|---|
| Load | каждый `tools/*.js` require'ится без ошибок, `index.js` синтаксически валиден | `npm run check` |
| Contract | реальный stdio-MCP сервер скила через `tests/helpers/mcp.js`: tools/list, ключ `0o600` и изоляция по `USER_ID`, вход/выход `speech_transcribe`, типизированные ошибки, ретрай, очистка tmp | `npm test` |
| Unit | парсинг ответа Deepgram, нормализация/mime, кольцо `calls.json` — без сети | `npm test` |
| Manifest | манифесты не разъезжаются с реестром тулов | `npm run manifest:check` |
| Core conformance | host-гейт `check-mcp-conformance.js`: пустой результат tools/call никогда не уходит моделью как пустой блок | `node <core>/scripts/check-mcp-conformance.js .` |

Внешняя сеть в тестах только loopback: заглушка Deepgram поднимается тестом
(`DEEPGRAM_API_HOST` = полный origin `http://127.0.0.1:<port>`), ключей и
платных вызовов нет. HTTP-таймауты обязательны; файлы токенов пишутся `0o600`;
никаких `require` к ядру — только цикл клонирования сиблингов в CI.

## Живой смоук

`node scripts/speech-smoke.cjs` — пара реальных файлов `media/intake`
(правило пары: аудио с наибольшим `mtime` ≤ `mtime` транскрипта), нормализация
регистра/пунктуации/пробелов и similarity ≥ 0.9. Оффлайн-часть (выбор пары,
метрика) гоняется без ключа; сама расшифровка требует ключ Deepgram
(`speech_status().key_present`) или разовый env-оверрайд `DEEPGRAM_KEY`.
Ручной прогон на хосте, в CI не входит.
