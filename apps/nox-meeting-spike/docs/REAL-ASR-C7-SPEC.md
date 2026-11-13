# NOX C7 — Инженерные условия подключения реального локального ASR (`sherpa-onnx`)

Документ фиксирует архитектурное решение, матрицу совместимости, выбор потоковой модели для русского языка, раздельный аудит лицензий, требования изоляции памяти и технические критерии перехода (Go / No-Go) от синтетического конвейера C7 к живому локальному распознаванию речи.

> **Статус подготовки:** код адаптера, изоляция хранения моделей, контрактные тесты (без весов и бинарников), оффлайн-проверка без сети и изолированный benchmark готовы. Пакеты `sherpa-onnx` не устанавливались, веса моделей не скачивались, автоматический захват микрофона и системного звука по-прежнему строго заблокирован (`PrivacyController`).

---

## 1. Совместимость с Windows x64, Node.js и Electron в Nox

Замеры среды в текущем рабочем пространстве `D:\nox-release`:

| Компонент | Версия / ABI в Nox | Замечание по совместимости |
|---|---|---|
| ОС и архитектура | `win32` / `x64` | Поддерживается нативно (`AMD Ryzen 5 5600X 6-Core Processor`, RAM ~15.93 GB) |
| Системный Node.js | `v24.22.1`, `NODE_MODULE_VERSION = 137`, `napi = 10` | Совместим через N-API (`node-addon-api`), сборка из C++ не требуется |
| Установленный Electron (`apps/jarvis-desktop`) | `44.9.3` (встроенный Node `24.22.0`, `modules = 149`, `napi = 10`) | ABI отличается от системного Node (`149` vs `137`), но единый **N-API 10** обеспечивает бинарную совместимость `.node` |
| Инструменты сборки C++ на машине | `cl`, `cmake`, `cargo`, `dotnet` отсутствуют в `PATH` | Предсобранный `sherpa-onnx-node` + `sherpa-onnx-win-x64` обязателен; **`electron-rebuild` запускать нельзя** (у пакета нет `binding.gyp`) |
| `electron-builder` в `apps/jarvis-desktop` | `^26.18.0`, `nsis`, уже есть `asarUnpack` для Python/TTS | При включении реального ASR на Этапе 2 необходимо добавить в `asarUnpack`: `node_modules/sherpa-onnx-node/**` и `node_modules/sherpa-onnx-win-x64/**` |

### Критические ловушки Electron на Windows x64 и их закрытие в коде

1. **Запрет V8 External Buffers (`External buffers are not allowed`, Electron >= 21):**
   Нативные вызовы вроде `sherpa_onnx.readWave(...)`, возвращающие внешний `ArrayBuffer`, вызывают падение V8 в Electron.
   **Решение:** реализован чисто-JS модуль `src/asr/pcm-utils.js` (`pcm16leToFloat32`, `parseWavBuffer`, `resampleLinearFloat32`), который аллоцирует обычные JS `Float32Array` и никогда не вызывает нативный `readWave`.
2. **Порядок загрузки DLL Windows (`onnxruntime.dll` / `sherpa-onnx-c-api.dll`):**
   Если в системе (`C:\Windows\System32` или глобальных инструментах) уже присутствует другая версия `onnxruntime.dll`, `LoadLibrary` может подхватить несовместимую DLL и упасть.
   **Решение:** `src/asr/sherpa-loader.js` (`prependDllSearchPath`) ставит каталог распакованного `sherpa-onnx-win-x64` в начало `PATH` до `require('sherpa-onnx-node')` и проверяет наличие `App.asar.unpacked`.
3. **Изоляция синхронного инференса от Main Process:**
   `OnlineRecognizer.decode()` — синхронная CPU-нагрузка C++. В Electron Main Process это блокирует цикл событий, окна, трей и хоткеи, а ошибка ONNX Runtime роняет всё приложение.
   **Решение:** `RealASRProvider` по умолчанию работает в режиме `mode: 'worker'` (`src/asr/real-asr-worker.js`) поверх `stdin`/`stdout` NDJSON. Внутри Electron дочерний процесс запускается с флагом `ELECTRON_RUN_AS_NODE=1` без создания второго GUI-экземпляра Electron.

---

## 2. Выбор потоковой модели для русского языка

Зафиксирован каталог `src/models/model-catalog.js`.

### Основная модель: `ru-zipformer-vosk-int8` (по умолчанию)

- **Имя архива:** `sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16`
- **Архитектура:** `Zipformer2 Transducer` (`recognizerKind: 'transducer'`, `modelType: 'zipformer2'`, `greedy_search`)
- **Частота / признаки:** нативные **16 000 Гц**, 80-мерные fbank
- **Файлы:** `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, `tokens.txt`
- **Размер:** ~32 МБ архив / ~35 МБ на диске / ~280 МБ пиковой RAM процесса-воркера (ориентир до замера на целевом аудио)
- **Почему выбрана основной:**
  1. Нативная частота 16 кГц совпадает с речевым пайплайном C7 (без потери полосы 4–8 кГц и без обязательного даунсэмплинга).
  2. Потоковая Transducer-архитектура с встроенным endpointing (`rule1MinTrailingSilence`, `rule2MinTrailingSilence`, `rule3MinUtteranceLength`).
  3. Небольшой размер весов и низкий CPU RTF благодаря int8-квантизации.

### Альтернативы в каталоге

1. **`ru-zipformer-vosk-fp32`** (`sherpa-onnx-streaming-zipformer-small-ru-vosk-2025-08-16`, ~88 МБ архив / ~92 МБ на диске):
   полноточная FP32-версия для честного A/B-сравнения WER/CER и RAM против `int8` в `benchmark-real-asr.js`.
2. **`ru-tone-ctc-8k`** (`sherpa-onnx-streaming-t-one-russian-2025-09-08`, ~80 МБ архив / ~280 МБ распакованная, `8 000 Гц`, Conformer CTC от `voicekit-team/T-one`):
   резервный вариант для узкополосной телефонии; на созвонах требует даунсэмплинга 16 -> 8 кГц и свежей версии `sherpa-onnx-node` с поддержкой `OnlineModelConfig.toneCtc` (PR #2567).

---

## 3. Раздельный аудит лицензий (код vs веса) и коммерческое распространение

Код runtime и веса нейросетей проверяются **отдельно** (`RUNTIME_COMPONENT_LICENSES` и `weightsLicense` в `src/models/model-catalog.js`):

### А. Лицензии программной обвязки (код / бинарники)

| Компонент | Назначение | Лицензия | Коммерция | Обязательные условия поставки |
|---|---|---|---|---|
| `sherpa-onnx-node` | Node.js N-API обёртка | **Apache-2.0** | Да | Включить текст `Apache-2.0` и `NOTICE` в дистрибутив; документировать свои правки при форке |
| `sherpa-onnx-win-x64` | Прекомпилированные `.node` и `sherpa-onnx-c-api.dll` | **Apache-2.0** | Да | Сохранить `LICENSE` и `NOTICE` от `k2-fsa/sherpa-onnx` |
| `onnxruntime.dll` | Исполняемый движок ONNX (Microsoft) | **MIT** | Да | Включить copyright и текст MIT `onnxruntime` |
| `kaldi-native-fbank` | Встроенный потоковый экстрактор признаков | **Apache-2.0** | Да | Сохранить уведомление `Apache-2.0` |

### Б. Лицензии весов нейросетей

| Модель | Upstream | Репак sherpa-onnx | Лицензия весов | Коммерция | Риск и закрытие в `ModelStore` |
|---|---|---|---|---|---|
| `ru-zipformer-vosk-int8` / `fp32` | `alphacep/vosk-model-small-streaming-ru` | `csukuangfj/sherpa-onnx-streaming-zipformer-small-ru-vosk-2025-08-16` | **Apache-2.0** | Да | В Hugging Face-карточке репака `csukuangfj` не заполнен YAML-тег `license`, хотя исходный релиз Alpha Cephei под **Apache-2.0**. **Закрытие:** `ModelStore` с `requireAttributionNotice: true` требует локальный `NOTICE`/`LICENSE` в папке модели, а `buildDownloadPlan` генерирует текст атрибуции. |
| `ru-tone-ctc-8k` | `voicekit-team/T-one` | `csukuangfj/sherpa-onnx-streaming-t-one-russian-2025-09-08` | **Apache-2.0** | Да | Явная лицензия `Apache-2.0` и в upstream, и на HF. Обязателен локальный `NOTICE`. |

> **Итог для коммерции:** copyleft-заражения (GPL/AGPL) ни в обвязке, ни в выбранных весах нет. При коммерческом распространении Nox достаточно включить файл third-party attributions (Apache-2.0 + MIT + upstream `NOTICE` модели).

---

## 4. Архитектура адаптера, жизненный цикл и память

Реализованные модули внутри изолированного пакета `apps/nox-meeting-spike`:

- `src/asr/real-asr-provider.js` — `RealASRProvider extends ASRProvider`
- `src/asr/sherpa-streaming-engine.js` — единое ядро работы с `OnlineRecognizer` и независимыми `OnlineStream` на каждый аудиоканал (`microphone`, `system_loopback`)
- `src/asr/real-asr-worker.js` — изолированный процесс-воркер (`node` или `Electron ELECTRON_RUN_AS_NODE=1`)
- `src/asr/pcm-utils.js` — безопасное преобразование PCM16LE/WAV -> `Float32Array` и ресэмплинг без External Buffers
- `src/asr/sherpa-loader.js` — проверка совместимости ABI/ASAR, настройка `PATH` для DLL, безопасная загрузка без автоустановки
- `src/models/model-store.js` — изоляция хранилища весов, локальная SHA-256 и NOTICE проверка без выхода в сеть

### Гарантии безопасного жизненного цикла

1. **Старт (`connect`):** сначала строго локально вызывает `ModelStore.resolveRecognizerFiles()` (без сети, при отсутствии весов падает с `ModelNotInstalledError`), затем поднимает воркер/движок с таймаутом `connectTimeoutMs` и поддержкой `AbortSignal`.
2. **Подача аудио (`pushAudio`):** так как `SessionManager._runPump()` обнуляет `chunk.pcm.fill(0)` сразу после завершения `pushAudio()`, адаптер **синхронно копирует** PCM-байты до любого `await`, переносит копию в ограниченный `_replayBuffer` (`maxReplayBufferBytes = 1 MB`) и немедленно зануляет временные буферы после кодирования.
3. **Остановка (`flush` + `close`):** при `flush()` добавляет хвостовую тишину (`tailPaddingMs = 400 ms`, чтобы дочитать финальные фонемы) только в те каналы, где действительно был необработанный звук (`hasUnflushedAudio`), вызывает `stream.inputFinished()` и `decode`, затем при `close()` мягко завершает воркер, освобождает нативные `stream.free()` / `recognizer.free()` и обнуляет `_replayBuffer`.
4. **Немедленная отмена (`abort`):** синхронно переводит состояние в `aborted`, отклоняет все ожидающие RPC, убивает дочерний процесс-воркер и зануляет буферы памяти без блокировки. Перезапуск `recover()` из терминальных состояний `aborted`/`closed` запрещён.
5. **Сбой и восстановление (`recover`):** при падении воркера (`SIGSEGV` / non-zero exit) или зависании (`decodeTimeoutMs = 5000 ms`, ошибка `AsrTimeoutError`) основной процесс не падает; переходит в `failed`, а `recover()` с бюджетом `maxRestarts` поднимает чистый воркер с новым PID и доигрывает накопленный буфер повтора.
6. **Ограничения памяти:**
   - `maxConcurrentChannels = 2` (раздельные `OnlineStream` для микрофона и системного звука, без смешивания и без утечки каналов);
   - `maxUtteranceDurationMs = 25000` (принудительная разбивка длинной непрерывной речи + `recognizer.reset(stream)`, чтобы не раздувать граф декодера);
   - `maxPendingAudioBytes = 4 MB` и `maxPendingChunks = 256` (`AsrBackpressureError`);
   - `maxRssBytes = 768 MB` (`AsrMemoryLimitError` с контролем в воркере и основном процессе).

---

## 5. Отделение моделей от исходников Nox и разговоров пользователя

`ModelStore` (`src/models/model-store.js`) принудительно изолирует хранилище весов через `assertIsolatedModelPath`:

- **Разрешённое расположение по умолчанию (Windows):** `%LOCALAPPDATA%\NoxAssistant\models\asr\<archiveName>` (или внешний путь через `NOX_ASR_MODELS_DIR`).
- **Жёсткий запрет:** любые пути внутри `apps/`, `apps/jarvis-desktop/`, `apps/nox-server/`, `apps/nox-meeting-spike/src/`, `.spike-sessions/`, `data/`, `workspace/`, `NOX_DATA_DIR`, а также рядом с файлами пользовательских разговоров (`chats.json`, `journal.jsonl`, `memory.json`, `conversation.json`, `.env`).
- **Сетевая изоляция:** `inspectModel()` и `resolveRecognizerFiles()` не делают никаких сетевых вызовов; `installWithConsent()` требует явного `userConfirmed: true` и `offlineOnly: false` (сейчас не подключён).

---

## 6. Запрет реального аудиозахвата и проверка без сети

1. Интеграция `RealASRProvider` внутрь `SessionManager` сохраняет все существующие барьеры `PrivacyController`: старт без `captureConsent: true` отклоняется (`ConsentRequiredError`), а попытка передать источник `microphone` или `wasapi_loopback` немедленно блокируется (`HardwareAccessForbiddenError`).
2. `scripts/verify-offline.js` (`npm run verify-offline`) перехватывает `http`, `https`, `net`, `net.Socket.connect`, `tls`, `dns` и `globalThis.fetch`, проверяя, что `ModelStore`, `RealASRProvider`, полный цикл `SessionManager` и `benchmark-real-asr.js --mock` выполняются с `attemptedNetworkCalls === 0`.
3. `tests/real-asr-contract.test.js` и `tests/model-store-and-bench.test.js` проверяют все контракты без установленных бинарников и без скачанных весов.

---

## 7. Изолированный Benchmark (`scripts/benchmark-real-asr.js`)

Доступен в двух режимах:

- **Сухой прогон без модели и бинарника:** `npm run bench:real-dry` (`node scripts/benchmark-real-asr.js --mock`) — проверяет расчёт метрик, загрузку и жизненный цикл на фиктивном декодере во временной папке.
- **Прогон на реальном русском аудио (после разрешения владельца):**
  `node scripts/benchmark-real-asr.js --models-dir <путь_к_моделям> --model ru-zipformer-vosk-int8 --wav <sample.wav> --ref-file <ref.txt> --pace realtime` (или `--manifest <dataset.json>`).

Измеряемые показатели:

- Время загрузки модели (`modelLoadMs`)
- Задержка первого `partial` (`firstPartialMs`: min/mean/p50/p95/max)
- Задержка финализации после конца фрагмента (`finalFlushMs`)
- Покадровый roundtrip (`perChunkRoundtripMs`)
- **RTF и CPU:** `wallRtf`, `decodeRtf`, `cpuRtf`, `cpuPercentOfWall`, `fasterThanRealtime`
- **Память:** `baselineRssMb`, `postLoadRssMb`, `peakRssMb`, `deltaRssMb`
- **Точность:** `WER %` (S/D/I breakdown с нормализацией `ё -> е`, регистра и пунктуации) и `CER %`

---

## 8. Точный список зависимостей на одобрение владельца (Этап 2)

На текущем этапе **ничего из этого не установлено**. Для включения настоящего распознавания речи потребуются:

1. **NPM-пакеты (устанавливаются после явного одобрения владельца):**
   - `sherpa-onnx-node` (`~2.0.x`, Apache-2.0) — Node.js N-API обвязка (зависимостей в реестре: `0`).
   - `sherpa-onnx-win-x64` (`~2.0.x`, Apache-2.0) — платформенные бинарники для Windows x64 (`sherpa-onnx.node`, `sherpa-onnx-c-api.dll`, `onnxruntime.dll` под MIT).
   *(Примечание: устанавливаются в `apps/nox-meeting-spike` или после переноса C7 в optionalDependencies `apps/jarvis-desktop`, без вызова `electron-rebuild`.)*
2. **Внешний архив весов (скачивается пользователем или после отдельного согласия в UI в `%LOCALAPPDATA%\NoxAssistant\models\asr\`):**
   - `sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16.tar.bz2` (~32 МБ, Apache-2.0) + контрольная сумма SHA-256 и файл `NOTICE`.
   - Опционально для A/B замеров точности: `...-fp32` (~88 МБ) и эталонный русский WAV-набор (только оффлайн-файлы для benchmark).
3. **Для сборки дистрибутива Electron (`apps/jarvis-desktop/package.json`, только при интеграции C7 в приложение):**
   - Добавить `node_modules/sherpa-onnx-node/**` и `node_modules/sherpa-onnx-win-x64/**` в `build.asarUnpack`.

---

## 9. Технические условия перехода к реальному ASR (критерии Go / No-Go)

Переход к установке `sherpa-onnx` и замерам на живых весах разрешён только при выполнении всех условий:

1. **Обязательные прохождения сейчас (Go для Этапа 1.5 / разрешения установки):**
   - `npm test` в `apps/nox-meeting-spike` — 100% зелёный (включая все синтетические тесты + контрактные тесты `RealASRProvider` + тесты `ModelStore` и метрик).
   - `npm run verify-offline` — `attemptedNetworkCalls === 0`.
   - `npm run bench:real-dry` — `ok === true`.
   - Основное приложение (`apps/jarvis-desktop` `node --test`) и сервер (`apps/nox-server` `node --test`) не затронуты и проходят полностью.
2. **Пороговые критерии приёмки на реальных весах (Go для включения в C7 runtime после замера benchmark'ом):**
   - **RTF:** `decodeRtf <= 0.45` и `wallRtf <= 0.65` на 2 каналах одновременно на целевом CPU (`--pace fast` и `--pace realtime`) — запас не ниже 1.5x от реального времени.
   - **Задержка отклика:** первый `partial` <= `500 ms` при чанках `100 ms` в `--pace realtime`; `finalFlushMs` p95 <= `400 ms`.
   - **Память:** прирост `deltaRssMb` <= `450 MB` для одного активного распознавателя (при потолке `maxRssBytes = 768 MB`), отсутствие утечки RSS на длинном тесте (10+ минут).
   - **Качество русского ASR:** контрольный замер `WER <= 18%`, `CER <= 8%` на наборе чистых русских реплик созвона (16 кГц).
   - **Стабильность Electron + Worker:** успешная загрузка `sherpa-onnx-node` внутри процесса Electron `ELECTRON_RUN_AS_NODE=1` без ошибки `External buffers are not allowed` и без конфликта DLL.
3. **Строгое ограничение безопасности (No-Go при любом нарушении):**
   - Микрофон и WASAPI loopback остаются полностью отключены (`HardwareAccessForbiddenError`), пока владелец отдельно не утвердит Этап 2 захвата звука и UI-индикацию записи/согласия.
