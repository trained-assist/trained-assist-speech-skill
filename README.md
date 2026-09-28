# trained-assist-speech-skill

Единый стандарт распознавания речи для trained-assist: **один** смысловой инструмент
`speech_transcribe` вместо шести независимых копий Deepgram-вызова.

Сиблинг `trained-assist-agent`: подключается `scripts/deploy.sh` (`ensure_sibling`),
монтируется в профиль как MCP-сервер `speech-skills`, секция каталога
`recruiting/interview` — доступность речи совпадает с доступностью видео-цепочки.

## Инструменты

| Тул | Назначение |
|---|---|
| `speech_transcribe` | аудио/файл/ссылка → текст. Deepgram `nova-2`, `language=ru` (de facto), `smart_format=true`. Поля `keywords`/`diarize` зарезервированы под Ф1/Ф2 и **выключены**: при `diarize:true` или непустом `keywords` возвращает типизированную ошибку `feature_disabled` |
| `speech_set_key` | сохранить ключ Deepgram в `~/agent-tokens/<USER_ID>/deepgram/key.txt` (`0o600`) |
| `speech_status` | `{key_present, last_calls}` — durable-журнал метаданных вызовов (`calls.json`, без текста) |

Аудио-only: видео-контейнер → `unsupported_source` (декод видео остаётся в ядре,
`video_analyze_batch`).

## Локальная проверка

```
npm ci
npm run check      # каждый тул require'ится
npm test           # contract + unit, loopback-заглушка Deepgram, без ключей
npm run manifest:check
```

Песочница ядра (запускается из trained-assist-agent): `npm run sandbox:speech`.

Правила CI: [docs/skill-ci.md](docs/skill-ci.md).
Сценарий: `docs/user-scenarios/speech/01-speech-transcribe.md` в ядре.
