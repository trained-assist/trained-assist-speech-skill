# trained-assist-speech-skill

**GCP VM exit (05.10.2026):** New work on `alesa-personal-assistent/us-central1-a/alesa-vm` is prohibited. Use serverless by default; the existing French VM only for a proven persistent or local requirement. Other Google services remain allowed. See [the exit plan](https://github.com/trained-assist/trained-agent-architecture/issues/145).


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
| `speech_status` | `{key_present, key_source, last_calls}` — durable-журнал метаданных вызовов (`calls.json`, без текста) |

Какой ключ берётся (первый непустой): `DEEPGRAM_KEY` (разовый оверрайд) → личный
`key.txt` профиля → `DEEPGRAM_API_KEY` — общий ключ платформы, который хост передаёт
MCP-серверу (тем же ключом расшифровываются голосовые на входе). `key_source` =
`env | profile | platform | null`.

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
