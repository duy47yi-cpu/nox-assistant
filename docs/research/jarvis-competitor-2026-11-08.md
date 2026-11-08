# Конкурент Jarvis.exe: разбор установленного приложения (REA)

**Дата:** 08.11.2026, Asia/Oral
**Артефакт:** `C:\Users\abdut\Downloads\AyuGram Desktop\Jarvis.exe`
**SHA-256:** `8b9f480d09889fcae37b147b9dd4e306dfbaee912d2645e30cda3995c09380ff`
**Размер:** 150 431 220 байт (150 МБ)
**Метод:** REA `/reverse-engineer-anything`: `open_binary` → `inspect_artifact` (PyInstaller CArchive) → `extract_artifact` (1 246 файлов) → разбор `jarvis_settings.json`, `jarvis_commands.json`, `Services/speech-grammar.json`, аудио-пака и байткода `main`. Приложение не запускалось, код не исполнялся; выводы — статические факты из поставки. Снимки настроек приложены владельцем отдельно.

## 1. Что это за приложение

- **PyInstaller 2.1, onefile**, Python **3.12**, без шифрования (`encryption_marker_present: false`), архив начинается с 545 280 байта, 402 записи, 1 246 файлов.
- UI — **PySide6 (Qt 6)**: в поставке 113 МБ Qt, включая плагины и переводы.
- Речь — **Vosk `vosk-model-small-ru-0.22`** (87 МБ) офлайн, плюс `sounddevice`/`pyaudio`/`soundfile` (запись и обработка), `lux_audio` — собственный **AGC** (автоматическая регулировка усиления микрофона: `LuxAgc`, `process_pcm16`, статистика громкости).
- Системные действия — `pywin32` (SendKeys, окна, COM), `psutil`, `serial` (Arduino), `cryptography` (лицензия/учёт), `requests`, `yaml`, `numpy`, `PIL`.
- Код приложения — один огромный модуль `main` (2,6 МБ байткода, 1 789 code-объектов, 101 класс/функция верхнего уровня) плюс три модуля в PYZ: `jarvis_telegram.pyc`, `jarvis_waves1.pyc`, `lux_audio.pyc`.
- Данные рядом: `jarvis_settings.json`, `jarvis_commands.json`, `jarvis_news_cache.json`, `Jarvis_Sound_Pack/` (15 MP3), `Services/speech-grammar.json` (338 фраз для грамматики Vosk).

Классы верхнего уровня (наблюдение): `JarvisWindow`, `HomePage`, `SettingsPage`, `CommandPage`, `ProfilePage`, `PluginsPage`, `VoiceCardFrame`, `OutputTextWindow`, `OverlayHintBubble`, `SpeechRecognitionWorker`, `QwenInstallWorker`, `AIAuthDialog`, `ProPlanDialog`, `HomeNewsWorker`, `ConfirmSideSquares`, `StructurePickerDialog`, `ActionPickerDialog`.

## 2. Настройки: полная карта (из `jarvis_settings.json`)

Файл — 3 582 байта, ~85 ключей. Группы:

**Режимы и речь**
- `prefix_word: "джарвис"`, `prefix_mode_enabled`, `prefix_sensitivity: 100`, `fuzzy_recognition_percent: 100`
- `silent_mode_enabled`, фразы переключения: `"перейди в режим префикса"`, `"перейди в тихий режим"`, `"хватит слушать"`
- `recognition_model: "Vosk: vosk-model-small-ru-0.22"`, `recognition_sensitivity: 115`
- `auto_activate_mic`, `microphone_model: "default"`, `voice_followup_after_wake_sec: 4`, `voice_command_execute_delay_ms: 30`

**Подтверждения**
- `confirm_phrase: "да, правильно, подтверждаю"`, `cancel_phrase: "нет, отмена, отменить"`, `cancel_triggers: "останови команду"`, `auto_cancel_seconds: 30`

**Склейка команд**
- `command_link_words: "и, затем, потом"` — одна фраза из нескольких команд

**Окно и вид**
- `ui_window_size: {w: 758, h: 468}`, `ui_window_corner_radius: 22`, `ui_sidebar_position: "top"`
- `window_transparency: 32`, `waves_blur: 22`, `background_color: "#020204"`, `accent_color: "#ff3b30"`
- `animations_enabled`, `overlay_enabled`, `overlay_position: "right"`, `always_on_top`, `close_to_tray`, `autostart`
- свободная раскладка панелей: `home_panel_layout` (доли x/y/w/h), `ui_base_overrides`, `ui_section_scales`, `ui_widget_overrides`, `ui_text_overrides` — **встроенный редактор интерфейса**: двигать панели, менять тексты, масштаб секций

**Голос**
- `selected_voice: "jarvis_pack"`, `voice_folders: []`, `voice_folder_labels` — **голосовые паки**: папка с WAV/MP3, по имени файла подбирается фраза; 15 файлов в базовом паке: `Активационная`, `Выполняю`, `Готово`, `Ошибка?`, `Время`, `Пауза`, `Подтверждение`, `Диагностика системы`, `Информация на экране`, `Курсор смещен`, `Перемотал`, `Спасибо`, `Удачи вам`, `Приятного просмотра`, `Увеличил/Уменьшил яркость`

**Нейро (ИИ)**
- `ai_fallback_enabled: true`, `ai_fallback_threshold: 42`, `ai_activation_mode: "wake_phrase"`, `ai_activation_phrase: "джарвис нейро"`
- `ai_provider: "ollama_local"`; поддерживаются **Qwen OAuth, Ollama (локально), OpenRouter, OpenAI**, ключи в настройках
- `presentation_style: "modern_dark"`, `ai_response_size: "auto"`, `wikipedia_search_enabled: true`
- новости: `home_news_enabled`, `home_news_topic: "it"`, RSS-источники (NASA breaking news, Universe Today, RSS-мост Telegram)

**Telegram-бот**
- `tg_bot_enabled`, `tg_bot_token`, `tg_bot_allowed_chat_id`, `tg_bot_password` — команды из Telegram выполняются как обычные, вход по `/login <пароль>`

**Установка и лицензия**
- `install_login`, `install_activation_key`, `install_path: "C:\\Program Files\\jarvis"`, `install_qwen_components`, `install_create_shortcut`, `install_autostart`, `first_launch_completed`, `ai_onboarding_done`

## 3. Движок команд (из `jarvis_commands.json`)

39 базовых команд в папке `Jarvis/Базовые команды`, схема `version: 1`:

```json
{ "name": "Ютуб", "phrase": "ютуб, ютюб", "optional_phrase": "открой, запусти, зайди в",
  "confirm": false, "combination_mode": false,
  "actions": [ {"id": "sound_playstream", "name": "Sound.PlayStream", "value": "Jarvis_Sound_Pack\\Выполняю.mp3"},
               {"id": "launch_openurl", "name": "Launch.OpenURL", "value": "https://www.youtube.com/"} ] }
```

- **`optional_phrase`** — стартовые глаголы («открой, запусти, зайди в»), отдельно от самой фразы. Совпадение допускает любой из них.
- **`combination_mode`** — команда может быть частью склейки через `и / затем / потом` (в базе все `false`, механизм есть).
- **Типы действий** (13): `sound_playstream` (39), `inputkeys_send` (20, SendKeys-синтаксис `^v`, `{ENTER}`, `%{TAB}`), `launch_openurl` (5), `launch_command_line` (2, `start winword`), `window_close`, `window_maximize`, `window_normalize`, `window_minimize`, `mouse_leftclick`, `sound_setvol` (`{1}` — подстановка числа из фразы), `system_monitor_off`, `system_sleep`, `jarvis_pause`.
- Грамматика Vosk — 338 фраз: обращение (`джарвис/джервис/жарвис/jarvis`), да/нет/отмена, режимы, громкость/яркость, «открой/запусти/включи/выключи», глаголы видео (`перемотай…`).

## 4. Архитектура по байткоду `main` (наблюдение, без декомпиляции)

- `JarvisWindow` — центральное окно: `_load_settings/_save_settings`, `apply_theme`, `apply_transparency`, `_apply_background_color`, `_apply_base_layout`, `_build_stylesheet`, `_apply_language`, `_apply_runtime_settings`, `_restore_factory_settings`.
- Распознавание: `SpeechRecognitionWorker`, `_on_speech_text_recognized`, `_push_speech_phrase_fragment`, `_flush_speech_phrase_buffer`, `_looks_like_neuro_question_phrase`.
- Команды: `CommandPage`, `StructurePickerDialog`, `ActionPickerDialog`, `CommandConfirmDialog`, `load_jarvis_commands_from_xml`, `_parse_xml_root`, `_translate_widget_tree` (украинский/русский), `_is_disabled_command_name`.
- Нейро: `_run_ai_prompt`, `_run_qwen_prompt`, `_run_ollama_prompt`, `_run_openrouter_prompt`, `_build_ai_answer_prompt`, `AIAuthDialog`, `QwenInstallWorker`.
- UI-редактор: `_editable_text_widgets`, `_apply_text_overrides`, `_set_ui_base_override`, `_apply_ui_widget_overrides`, `_resolve_section_widget_overlap`.
- Оверлей: `OverlayHintBubble`, `_update_overlay_chip`, `_apply_always_on_top`.
- Плагины: `PluginsPage`, `_on_plugin_create_command`, `_on_plugin_probe_requested`, `_execute_arduino_script`.
- **Arduino-плагин** (неожиданно много): компиляция/загрузка скетчей через `arduino-cli`/`avrdude`, генерация кода через Qwen, лимит бесплатных запусков, учёт через подписанный реестр с отпечатком устройства, покупка Pro через Telegram.
- Монетизация: `ProPlanDialog`, `ProHoverBuyButton`, `_open_pro_purchase_telegram`, `_maybe_show_arduino_pro_dialog`.
- Новости: `HomeNewsWorker`, `ProfileCodeXNewsWorker`, `jarvis_news_cache.json`.
- Озвучка: `_assistant_reply_for_phrase` (заготовленные ответы), проигрывание MP3 паков; звук «дзинь»/фразы на действия.

## 5. Сравнение с Nox (что у них есть, чего у нас нет)

| Возможность | Jarvis.exe | Nox сейчас | Что делать |
|---|---|---|---|
| Офлайн-распознавание | Vosk ru small внутри, грамматика 338 фраз, порог и чувствительность | диктовка Windows System.Speech | **Взять**: грамматика-подсказки повышают точность. Наш плюс — не тащим 87 МБ модели |
| Режимы: префикс / тихий / «хватит слушать» | фразы в настройках, отдельные режимы | wake-word «Джарвис», но нет тихого режима и стоп-фразы | добавить фразы «тихий режим», «хватит слушать» в офлайн-сокращения |
| Склейка фраз «и, затем, потом» | `command_link_words` | нет | добавить в разбор команд |
| Стартовые глаголы «открой/запусти» | `optional_phrase` | фразы целиком | добавить необязательный префикс в образцы/паки |
| Подтверждение/отмена фразой + авто-отмена 30 с | да, настраиваемо | диалог подтверждения, фраз нет | добавить фразы «да/нет/подтверждаю» для диалога |
| AGC микрофона | `lux_audio` PCM16 | нет | добавить нормализацию громкости в диктовку |
| Голосовые паки (папка WAV/MP3) | да, с выбором папки | TTS + `personas` (темп/громкость) | добавить чтение папки-пака и проигрывание фраз по имени |
| Оверлей-подсказка поверх окон | `OverlayHintBubble`, позиция справа | плашка «Nox работает» (`hands`) | расширить плашку до подсказок |
| Редактор интерфейса (двигать панели, менять тексты) | да, полностью | темы и «Вид», без редактора | не приоритет |
| Прозрачность/блюр/радиус окна | 32% / 22 / 22 | частично в `look.js` | добавить прозрачность и радиус окна |
| Нейро-провайдеры | Qwen OAuth, Ollama, OpenRouter, OpenAI, DuckDuckGo | свои ключи и провайдеры владельца | у нас сильнее: модели/лимиты на сервере |
| Новости RSS-панель | да (NASA/Universe/Telegram RSS) | нет | виджет новостей на столах |
| Telegram-бот (команды с паролем) | да | есть мост `src/telegram/bridge.js` | у нас есть, но без пароля-логина — проверить |
| Pro-план и платный плагин | да, Telegram-покупка, счётчики | серверные тарифы, оплата запрещена | бизнес-модель другая, не копируем |
| Системные действия | SendKeys/URL/CLI/окна/сон | инструменты `ui_keys/app_open/url_open/windows_*` + проверка результата | у нас безопаснее: политика и `verify` |
| Подтверждения опасных | флаг `confirm` у команды, в базе всё `false` | политика T0–T3 и подтверждения | у нас строже |

## 6. Что забрать первым (маленькие, полезные)

1. **`optional_phrase` + склейка фраз** — правка сопоставления команд: «открой ютуб» и «ютуб и громкость 30» работают без новых синонимов.
2. **Тихий режим и «хватит слушать»** — офлайн-сокращения поверх wake-word.
3. **Фразы подтверждения/отмены** для диалога согласия + авто-отмена по таймеру.
4. **Голосовые паки** — читать папку `voice-packs/<имя>/*.mp3`, играть `Выполняю/Готово/Ошибка`; свои файлы, не чужие.
5. **AGC** — простая нормализация уровня в диктовке.

## 7. Ограничения разбора

- Приложение **не запускалось**; поведение проверено только по настройкам, командам, грамматике, аудио-паку и инвентарю байткода. Реальные задержки, порядок шагов и сетевые адреса — не наблюдались.
- Байткод не декомпилировался: имена классов и методов — факт, логика внутри них — нет.
- Многие строки в байткоде хранятся в «кракозябрах» (mojibake) и чинятся в рантайме (`_fix_mojibake_text`) — качество сборки конкурента, не наша модель.
- Ключи и токены в поставке пустые; чужих секретов в отчёте нет.
- Скриншоты настроек (7 шт.) присланы владельцем отдельно; отчёт их не дублирует.
