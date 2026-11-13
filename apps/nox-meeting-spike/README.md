# Nox C7 — Изолированный прототип движка субтитров и конспекта созвонов

> **Статус этапа 1:** полностью изолированный движок и тестовый UI на **синтетических данных**.
> Микрофон, системный звук WASAPI, реальные ASR-модели и внешние API **не включены и не установлены**.
> Основное приложение (`apps/jarvis-desktop` и `apps/nox-server`) и задачи C5/C6 не затронуты.

## Что внутри

- `src/core/session-manager.js` — `SessionManager` (жизненный цикл, телеметрия задержек, координация)
- `src/audio/audio-stream-adapter.js` — контракт `AudioStreamAdapter` и синтетический генератор PCM16 `SyntheticAudioStreamAdapter`
- `src/asr/asr-provider.js` — контракт `ASRProvider` и имитатор потокового ASR `SyntheticASRProvider` (с режимами инъекции сбоев, задержек, дублей и битых меток)
- `src/transcript/transcript-assembler.js` — `TranscriptAssembler` (частичные/финальные сегменты, дедупликация, вставка опоздавших ответов, починка битых временных меток)
- `src/timeline/speaker-timeline.js` — `SpeakerTimeline` (шкала речи по каналам без выдумывания личности говорящего)
- `src/summary/meeting-summary.js` — `MeetingSummaryGenerator` (структурированный конспект со ссылками на `segmentId` и экспортом в Markdown)
- `src/runtime/cancellation.js` — `CancellationController` (AbortSignal, таймаут `stopGraceMs`, очистка таймеров)
- `src/runtime/error-recovery.js` — `ErrorRecoverySupervisor` (watchdog зависаний, ограниченные перезапуски и повтор хвоста аудио)
- `src/runtime/backpressure.js` — `BackpressureQueue` (жёсткие лимиты по количеству фрагментов и байтам RAM)
- `src/privacy/privacy-controller.js` — `PrivacyController` (явное согласие до старта, запрет микрофона/внешней сети, отзыв согласия)
- `src/storage/session-store.js` — `IsolatedSessionStore` (атомарная запись, защита от попадания в `data/` обычной истории Nox)
- `src/server/spike-server.js` и `ui/` — изолированный локальный HTTP+SSE интерфейс прототипа
- `docs/REAL-AUDIO-ARCHITECTURE.md` — архитектура подключения реального WASAPI loopback, анализ провайдеров (`sherpa-onnx`, `whisper.cpp`, `faster-whisper`, `Vosk`), лицензии, задержки и список зависимостей на согласование.

## Команды запуска (из `apps/nox-meeting-spike`)

| Задача | Команда |
|---|---|
| Полный прогон автотестов (19 тестов) | `npm test` (или `node --test tests/*.test.js`) |
| Демо-сценарий на синтетических данных | `npm run demo` |
| Замер задержек конвейера на 1000 фрагментах | `npm run bench` |
| Запуск изолированного UI-прототипа (http://127.0.0.1:4787) | `npm run ui` |
| Автоматическая проверка UI в окне Electron | `npm run verify-ui` |
