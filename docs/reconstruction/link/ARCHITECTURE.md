# Nox Link (С6) — Архитектура безопасности (Revision v3)

> **Статус документа:** Пересмотренная архитектура безопасности (**Revision v3**) по итогам блокеров аудита Fable 5.2.
>
> **Честная граница доказательности:**
> - Отдельный текстовый файл отчёта аудита Fable 5.2 в репозитории и вложениях к задаче **отсутствовал**; архитектура переработана по четырём зафиксированным направлениям блокеров, сопоставлена с кодом `docs/reconstruction/link/ARCHITECTURE.md` (v2), `link-tls-spike/*`, `apps/jarvis-desktop/*`, `apps/nox-server/*` и пробами в среде Electron 44.9.3 BoringSSL.
> - **Доказано на работающем стенде / пробах:** поведение Electron 44.9.3 BoringSSL (`openssl=0.0.0`) и Node v24.22.1 OpenSSL 3.5.9 с `CA:FALSE` листом (падение рукопожатия), 2-уровневой схемой Device Root CA + Leaf через `pkijs@3.4.3`, `NameConstraints`, проверкой отпечатка (pinning) и `getEphemeralKeyInfo() === null` на серверном сокете; а также прогон `link-tls-spike/stand.test.js` (11/11).
> - **Только спроектировано (реализация С6 НЕ начата):** производственные модули `apps/jarvis-desktop/src/link/*`, маршруты сопряжения и ретрансляции в `apps/nox-server/*`, fail-closed проверка блокировки Windows в `DesktopLock`, изолированный реестр удалённого агента и интеграция в интерфейс.

---

## 0. Сводка критических противоречий, устраняемых в Revision v3

1. **X.509 / BoringSSL:** Прототип `link-tls-spike/certs.js` вызывал `openssl req -x509` без `CA:FALSE`, поэтому выпускал самоподписанные сертификаты с `BasicConstraints: critical, CA:TRUE` (что делало лист центром сертификации и скрывало баг). При соблюдении профиля v2 (`CA:FALSE`, самоподписанный лист в `ca: [peer.cert]`) **Electron 44.9.3 BoringSSL отвергает рукопожатие ошибкой `UNABLE_TO_VERIFY_LEAF_SIGNATURE`**. Дополнительно v2 ставил `keyEncipherment` на ECDSA P-256 ключ, опирался на самописный ASN.1 DER и проверял `getEphemeralKeyInfo()` на серверном сокете, где он всегда возвращает `null`.
2. **Сопряжение и посредник:** `link-tls-spike/relay.js` позволял любому неаутентифицированному клиенту занять предсказуемую комнату `/link/<A>~<B>` (перехват комнаты / DoS), не содержал авторизации аккаунта, лимитов попыток, отзыва устройств и механизма обнаружения ожидающего подключения вторым ПК. SAS-код v2 не был привязан ни к `roomId`, ни к именам устройств, ни к полному транскрипту и доказательству владения ключом (PoP).
3. **Защита от повторов и сбои:** В v2 конфликтовали окно свежести `createdAt` (в разных местах 60 с и 24 ч) и кольцевой буфер `MAX_SEEN_IDS = 2000` (вытеснение по счётчику позволяло повторно прогнать неотработанные `msgId` в пределах TTL). `_accept()` синхронно вызывал `onTask` и сразу отдавал `status: 'done'`, смешивая доставку, выполнение и проверку эффекта; отсутствовали таймауты отправки/сердцебиения и восстановление незавершённых задач после перезапуска.
4. **Изоляция удалённого агента:** Прежний дизайн наследовал паттерн чёрного списка поверх общих инструментов, упоминал несуществующие в репозитории инструменты (`system_info`, `time_now`, `battery_status`, `network_status`, `calc`, `note_save`), тогда как `DesktopLock.locked` в `src/control/desktop-lock.js` стартует с `false` (не fail-closed при неизвестном состоянии), а `Agent.run` сбрасывает taint и в `main.js:buildRemoteAgent` работает с `mode: 'full'`.

---

## 1. X.509 и TLS 1.3

### 1.1. Почему нельзя ставить `CA:TRUE` на конечный (leaf) сертификат

Временный обход ошибки BoringSSL путём установки `CA:TRUE` на конечный сертификат TLS **неприемлем** по трём причинам:
1. **Смешение ролей ключей:** Один ключ подписывает и сеансы TLS 1.3 (`digitalSignature`), и сертификаты X.509 (`keyCertSign`). При любой утечке или компрометации TLS-ключа злоумышленник получает полномочия удостоверяющего центра устройства.
2. **Риск выпуска дочерних сертификатов:** Без жёсткого `pathlen:0` и `NameConstraints` сертификат с `CA:TRUE` математически допускает подписание промежуточных или новых дочерних сертификатов для произвольных доменов; если такой сертификат ошибочно попадёт в более широкий trust store, возможна подмена любых хостов.
3. **Невозможность ротации листа без потери доверия:** При одном уровне сертификата смена TLS-ключа на устройстве ломает якорь доверия на всех спаренных ПК и вынуждает повторять ручное сопряжение.

### 1.2. Целевой профиль X.509: двухуровневый PKI на каждом устройстве

Каждое устройство генерирует собственную изолированную пару уровня «Удостоверяющий центр устройства → Конечный сертификат TLS»:

| Параметр | Уровень 1: Device Root CA | Уровень 2: Device Leaf (конечный TLS) |
|---|---|---|
| **Ключ и подпись** | ECDSA P-256 (`ecdsa-with-SHA256`), отдельный ключ | ECDSA P-256 (`ecdsa-with-SHA256`), отдельный от CA ключ |
| **`serialNumber`** | 16 байт CSPRNG (положительный DER `INTEGER` со старшим битом `0`, непустой) | 16 байт CSPRNG (уникальный при каждой ротации) |
| **`Subject` / `Issuer`** | `CN=Nox Link Device CA (<deviceId>)` (самоподписанный) | `Subject: CN=<deviceId>.link.nox`, `Issuer: CN=Nox Link Device CA (<deviceId>)` |
| **`BasicConstraints`** | **`critical: true`, `cA: true`, `pathLenConstraint: 0`** | **`critical: true`, `cA: false`** |
| **`KeyUsage`** | **`critical: true`, `keyCertSign \| cRLSign`** (`0x06`, DER `BitString` `unusedBits=1`); запрещены `digitalSignature`/`keyEncipherment` | **`critical: true`, `digitalSignature`** (`0x80`, DER `BitString` `unusedBits=7`); **запрещены** `keyEncipherment`, `keyCertSign` |
| **`ExtendedKeyUsage`** | Отсутствует | `serverAuth` (`1.3.6.1.5.5.7.3.1`), `clientAuth` (`1.3.6.1.5.5.7.3.2`) |
| **`SubjectAltName`** | Отсутствует | `DNS:<deviceId>.link.nox` (`deviceId` — строгий UUIDv4 в нижнем регистре) |
| **`NameConstraints`** | **`critical: true`, `permittedSubtrees: [DNS:<deviceId>.link.nox]`** | Отсутствует |
| **Идентификаторы ключей** | `SubjectKeyIdentifier` (SHA-1 от SPKI по RFC 5280) | `SubjectKeyIdentifier` + `AuthorityKeyIdentifier` (`keyIdentifier` = CA SKI) |
| **Срок действия** | Долгоживущий (например, 5–10 лет; `notBefore = now - 5m`) | Короткоживущий (`90 дней`; `notBefore = now - 5m`) |

> **Зачем оба ограничения на Root CA:** `pathlen:0` запрещает промежуточные CA, а `NameConstraints (permitted DNS:<deviceId>.link.nox)` заставляет движок X.509 BoringSSL и OpenSSL отвергать на уровне самого TLS-рукопожатия любой лист под этим CA, если в нём подменено имя (например, `evil.link.nox` или чужой `<otherId>.link.nox`). Дополнительно оба уровня пиннингуются приложением по SHA-256 отпечатку (см. §1.3).

### 1.3. Конфигурация Mutual TLS 1.3 в Electron BoringSSL и Node

- **Протокол:** строго `minVersion: 'TLSv1.3'`, `maxVersion: 'TLSv1.3'`.
- **Доверие и проверка цепочки (обе стороны):**
  - В `tls.createServer` и `tls.connect` передаются:
    - `cert: own.leafPem` (или цепочка `[own.leafPem, own.caPem]`), `key: own.leafKeyPem`
    - `ca: [expectedPeer.rootCaPem]` (строго один корневой сертификат конкретного ожидаемого пира, **никогда** системный trust store)
    - Сервер: `requestCert: true, rejectUnauthorized: true`
    - Клиент: `rejectUnauthorized: true, servername: hostOf(expectedPeer.deviceId), checkServerIdentity: (_, cert) => tls.checkServerIdentity(hostOf(expectedPeer.deviceId), cert)`
- **Обязательные проверки сразу после завершения TLS-рукопожатия (до передачи первого байта):**
  1. `socket.authorized === true` и `socket.getProtocol() === 'TLSv1.3'`.
  2. `peerCert = socket.getPeerX509Certificate()` существует, `peerCert.ca === false`, `Boolean(peerCert.checkHost(hostOf(expectedPeer.deviceId))) === true`.
  3. Выпуск цепочки подтверждён: `peerCert.checkIssued(expectedPeerRootX509) === true`.
  4. **Жёсткий пиннинг листа (`leafFp256`):** `crypto.timingSafeEqual(sha256Raw(peerCert.raw), expectedPeerLeafFp256)`.
     - *Зачем нужен пиннинг и CA, и листа:* проверено эмпирически (`TEST 4` пробы `pkijs`), что если у скомпрометированного CA появится второй лист с тем же SAN `<deviceId>.link.nox`, проверка `authorized: true` по CA+SAN пройдёт, но несовпадение `leafFp256` немедленно обрывает сокет до чтения данных.
     - Плановая ротация 90-дневного листа без пересопряжения в v1 **не выполняется автоматически по одному CA**: либо обновление `leafFp256` подтверждается владельцем / signed-envelope от старого ключа + CA при активной доверенной сессии, либо выполняется повторное сопряжение (минимальный безопасный вариант для v1 — уведомление об истечении за 14 дней и явное переподтверждение нового отпечатка).
- **Исправление ошибочной проверки `getEphemeralKeyInfo()` из v2 §2.3:**
  - На Electron 44.9.3 BoringSSL и Node 24.22.1 OpenSSL 3.5.9 **подтверждено опытным путём**, что `socket.getEphemeralKeyInfo()` на серверном `TLSSocket` возвращает `null`, а на клиентском — `{ type: 'TLSGroup', name: 'X25519MLKEM768' }`.
  - Архитектура **запрещает** проверять `getEphemeralKeyInfo().type === 'TLSGroup'` на серверном сокете. Эфемерный обмен ключами обеспечивается жёсткой фиксацией `TLSv1.3` (в RFC 8446 статический обмен ключами без PFS отсутствует), а поле `getEphemeralKeyInfo()` разрешено только читать на клиенте для диагностики, если оно отлично от `null`.

### 1.4. Выбор библиотеки генерации X.509 (без ручного ASN.1 DER и без `openssl.exe`)

Самописная сборка ASN.1 DER (`src/link/x509.js` из v2) **исключена**: ручное кодирование длин BER/DER, `unusedBits` для `BIT STRING`, таблиц `UTCTime`/`GeneralizedTime` и вложенных `GeneralSubtree` для `NameConstraints` несёт высокий риск скрытых дефектов парсинга. Внешний вызов `openssl.exe` также исключён.

- **Основной выбор: `pkijs@3.4.3` (лицензия `BSD-3-Clause`) + `asn1js@3.1.0` (`BSD-3-Clause`) через штатный `node:crypto.webcrypto` (`CryptoEngine`).**
  - Проверенные транзитивные зависимости на диске: `bytestreamjs@2.0.1` (`BSD-3-Clause`), `pvtsutils@1.3.6` (`MIT`), `pvutils@1.2.0` (`MIT`), `@noble/hashes@1.8.0` (`MIT`), `tslib@2.9.1` (`0BSD`).
  - Нативных модулей нет, проверено в Electron 44.9.3 BoringSSL и Node 24.22.1.
  - **Статус в проекте:** `pkijs@3.4.3` и `asn1js@3.1.0` **уже присутствуют в `apps/jarvis-desktop/package-lock.json`**, но помечены как `"dev": true` (через `electron-builder` / `app-builder-lib`). Это означает, что **без отдельного разрешения владельца на добавление `"pkijs"` и `"asn1js"` в раздел `"dependencies"` файла `apps/jarvis-desktop/package.json`** пакеты не попадут в собранный релизный бандл (`dist/`). На этапе проектирования пакеты не устанавливаются и `package.json` не изменяется.
- **Альтернатива: `@peculiar/x509` (лицензия `MIT`).**
  - Более высокоуровневый API для выпуска сертификатов (внутри использует те же структуры `asn1js`/`@peculiar/asn1-*`). Сейчас **отсутствует** в `node_modules` и `package-lock.json`, поэтому потребовал бы отдельного разрешения владельца на установку нового пакета. При прочих равных предпочтителен `pkijs@3.4.3` как уже зафиксированный в lock-файле и проверенный в пробах под Electron 44.9.3.

### 1.5. Хранение ключей на диске (`safeStorage`)

- Закрытые ключи `caKeyPem` и `leafKeyPem` шифруются через Electron `safeStorage.encryptString(...)` и хранятся в `<DATA_DIR>/link/identity.json` (права только текущего пользователя, поля `caKeyEnc`, `leafKeyEnc` в base64).
- **Fail-closed правило:** если `safeStorage.isEncryptionAvailable() !== true`, в обычном режиме приложения Nox Link **блокируется с ошибкой** и закрытые ключи на диск в открытом виде **не сохраняются**. Исключение допустимо исключительно в автоматизированных headless-тестах при одновременном наличии обеих переменных среды `NOX_DATA_DIR` (временная папка) и явного тестового флага `NOX_LINK_TEST_UNENCRYPTED_KEYS=1`.

---

## 2. Сопряжение, обнаружение второго ПК и защита посредника

### 2.1. Модель доверия к посреднику (`apps/nox-server`) и защита от перехвата комнат

Посредник решает две задачи: маршрутизация управляющих приглашений и слепая пересылка TLS-потока. Посредник **не является доверенным элементом конфиденциальности** (после завершения mTLS он видит только шифротекст TLS 1.3), однако он **критичен для доступности и предотвращения подмены/перехвата комнаты на этапе ожидания второго ПК**.

В прототипе `link-tls-spike/relay.js` любая третья сторона могла открыть `Upgrade: nox-link` на предсказуемый путь `/link/idA~idB` и занять место легитимного ПК. В Revision v3 это полностью закрывается:

1. **Транспорт до `apps/nox-server`:** в продакшене только `HTTPS / WSS` (TLS на reverse-proxy перед `apps/nox-server`). Обычный `HTTP / WS` разрешён исключительно на `127.0.0.1` в локальных тестах.
2. **Обязательная аутентификация аккаунта:** все HTTP и WebSocket/Upgrade-маршруты `/v1/link/*` проходят через существующий механизм токен-сессий в `apps/nox-server/store.js` (`accountByToken` — поиск SHA-256 хэша токена `nox_*`). Анонимные подключения запрещены (`401`).
3. **Реестр устройств аккаунта (таблица `link_devices` в SQLite `apps/nox-server`):**
   - Поля: `device_id TEXT PRIMARY KEY` (UUIDv4), `account_id TEXT NOT NULL`, `device_name TEXT NOT NULL`, `root_ca_fp256 TEXT NOT NULL`, `created_at INTEGER`, `last_seen_at INTEGER`, `revoked_at INTEGER NULL`.
   - При старте клиент под аккаунтом регистрирует своё устройство: `POST /v1/link/devices/register`. Если `device_id` уже зарегистрирован за **другим** `account_id` или имеет `revoked_at IS NOT NULL`, сервер возвращает `403`.
4. **Непредсказуемые одноразовые комнаты и роль-привязанные билеты (таблица `link_rooms` / TTL в памяти + БД):**
   - Предсказуемых URL `/link/A~B` больше нет.
   - Идентификатор комнаты `roomId` — 32 байта CSPRNG (hex/base64url).
   - Для комнаты создаются **два отдельных одноразовых билета** (`hostTicket`, `clientTicket`, 32 байта CSPRNG, на сервере хранятся только SHA-256 хэши, сравнение через `crypto.timingSafeEqual`):
     - `hostTicket` привязан к `(roomId, accountId, hostDeviceId, role='host', expiresAt)`.
     - `clientTicket` привязан к `(roomId, accountId, clientDeviceId, role='client', expiresAt)`.
   - Подключение к ретранслятору (`GET /v1/link/relay` с `Upgrade: nox-link`) требует:
     - заголовков `Authorization: Bearer <accountToken>`, `X-Nox-Device-Id`, `X-Nox-Room-Id`, `X-Nox-Join-Ticket`.
   - Сервер атомарно проверяет: совпадение `accountId`, отсутствие `revoked_at` у обоих устройств, соответствие `deviceId` и роли билета, срок жизни `expiresAt`, флаг `consumed === false`. Билет помечается `consumed = true` в момент приёма сокета.
   - В комнате ровно **2 слота** (`host` и `client`). Попытка третьего клиента или повторного использования билета даёт `409 Conflict` / `403 Forbidden`, не затрагивая уже подключённых участников.
   - Таймаут ожидания второго участника в комнате: `ROOM_WAIT_TIMEOUT_MS = 15_000`. Если второй участник не вошёл, сервер закрывает сокет #1 с кодом ошибки и уничтожает комнату.

### 2.2. Как второй компьютер обнаруживает ожидающее соединение

Проблема v2 заключалась в том, что ПК #2 не знал, когда ПК #1 открыл комнату и по какому идентификатору подключаться. В v3 оба ПК авторизованы под одним аккаунтом владельца в `apps/nox-server` и не открывают входящие TCP-порты на локальной сети:

1. **Регистрация и канал событий:** Когда Nox Assistant запущен и включён Nox Link, приложение держит исходящее SSE-соединение `GET /v1/link/events` (с заголовками `Authorization: Bearer <accountToken>`, `X-Nox-Device-Id`), а при разрыве/переподключении запрашивает `GET /v1/link/pending`.
2. **Обнаружение нового сопряжения (Pairing):**
   - ПК #1 запрашивает список онлайн/доступных устройств аккаунта: `GET /v1/link/devices`.
   - Пользователь на ПК #1 выбирает целевое устройство ПК #2 (`targetDeviceId`) и нажимает «Связать» → `POST /v1/link/pairings/start` `{ targetDeviceId }`.
   - `apps/nox-server` проверяет лимиты, генерирует `(roomId, hostTicket, clientTicket)` с `purpose = 'pair'`, `expiresAt = now + 120_000`, возвращает `(roomId, hostTicket)` ПК #1 и мгновенно отправляет событие `link.pair.invite` `{ roomId, clientTicket, fromDeviceId, fromDeviceName, expiresAt }` на ПК #2 через его SSE-канал (либо ПК #2 забирает это же приглашение через `GET /v1/link/pending`).
   - На ПК #2 показывается запрос владельцу: *«Устройство «<fromDeviceName>» (<shortId>) просит связаться. Начать проверку кода?»*. Только после клика «Принять» ПК #2 подключается к `/v1/link/relay` по полученным `(roomId, clientTicket)`.
3. **Обнаружение рабочего сеанса (после уже выполненного сопряжения):**
   - Когда ПК #1 хочет отправить задачу уже спаренному ПК #2 (а активного mTLS-канала ещё нет), ПК #1 вызывает `POST /v1/link/sessions/open` `{ targetDeviceId }`.
   - Сервер проверяет, что оба устройства принадлежат одному `account_id`, оба не отозваны (`revoked_at IS NULL`), выдаёт эфемерные `(roomId, hostTicket, clientTicket)` с `TTL = 15_000 мс` и отправляет по SSE на ПК #2 событие `link.session.incoming` `{ roomId, clientTicket, fromDeviceId, expiresAt }`.
   - ПК #2 локально сверяет `fromDeviceId` со своим `peers.json` (если устройство неизвестно или локально отозвано — **молча игнорирует и не подключается**), иначе автоматически подключается к ретранслятору, где **финальную аутентификацию всё равно выполняет mTLS 1.3 с пиннингом Root CA и Leaf отпечатка**.

> *Примечание для режима без сопряжения через общий список устройств (опционально для будущего шага):* если на ПК #2 устройство ещё не видно в списке, одноразовый короткий код приглашения отображается на ПК #2 только после его явной регистрации в `link_devices` на сервере; прямой неаутентифицированный вход по угадываемому коду комнаты **не допускается**.

### 2.3. Криптографическое связывание SAS, транскрипта, имён устройств и PoP

Чтобы защититься от подмены имён, unknown-key-share атак и подбора nonce при несимметричном раскрытии данных, сопряжение проходит строго по фазам:

1. **Подготовка (локально на каждом ПК):**
   - Свои данные: `role` (`'host'` или `'client'`), `deviceId`, `deviceName` (нормализованное UTF-8 NFC, без управляющих символов, `<= 64` символов), `caPem`, `leafPem`, `caFp256`, `leafFp256`, `nonce` (32 байта CSPRNG).
   - Упаковка с явным префиксом длины `lp(x) = u32be(Buffer.byteLength(x)) || Buffer.from(x)`.
2. **Фаза 1 — Commit (обязательна до раскрытия):**
   - Каждый отправляет по каналу ретранслятора:
     `commit = SHA256("NOX-PAIR-COMMIT-V3" || lp(roomId) || lp(role) || lp(deviceId) || lp(deviceName) || lp(caPem) || lp(leafPem) || lp(nonce))`.
   - **Инвариант:** ни одна сторона не отправляет сообщение Reveal, пока не получен валидный 32-байтный `commit` второй стороны (таймаут фазы 15 с).
3. **Фаза 2 — Reveal и проверка сертификатов:**
   - Стороны обмениваются `{ role, deviceId, deviceName, caPem, leafPem, nonce }`.
   - Каждая сторона проверяет:
     - `commit` совпадает с пересчитанным (`timingSafeEqual`);
     - `role` противоположен своей роли; `deviceId` и `deviceName` совпадают с метаданными приглашения от `nox-server` (имя устройства от сервера и от пира не расходятся!);
     - `caCert` и `leafCert` соответствуют всем требованиям §1.2 (`CA:TRUE, pathlen:0, NameConstraints` для `caCert`; `CA:FALSE, digitalSignature, serverAuth+clientAuth, SAN=DNS:<deviceId>.link.nox`, `leafCert.checkIssued(caCert)` и текущий срок годности).
4. **Фаза 3 — Переход на Mutual TLS 1.3 + Proof-of-Possession (PoP):**
   - Поверх открытой комнаты ретранслятора стороны выполняют **mTLS 1.3 рукопожатие** на основе только что раскрытых и проверенных `caPem`/`leafPem` (пинированных в памяти сеанса сопряжения). Это сразу доказывает владение `leafKey` через TLS `CertificateVerify`.
   - Дополнительно, чтобы связать подпись напрямую с метаданными комнаты и именами устройств, вычисляется **канонический хэш транскрипта**:
     ```text
     transcriptHash = SHA256(
       "NOX-PAIR-TRANSCRIPT-V3" ||
       lp(roomId) ||
       lp(host.deviceId) || lp(host.deviceName) || lp(host.caFp256) || lp(host.leafFp256) || lp(host.nonce) ||
       lp(client.deviceId) || lp(client.deviceName) || lp(client.caFp256) || lp(client.leafFp256) || lp(client.nonce)
     )
     ```
   - Каждая сторона внутри установленного mTLS-туннеля подписывает своим закрытым ключом листа сообщение `"NOX-PAIR-POP-V3" || transcriptHash` и проверяет подпись пира его открытым ключом листа.
5. **Фаза 4 — Вычисление и визуальное подтверждение SAS:**
   - SAS выводится через `crypto.hkdfSync('sha256', ikm, salt, info, 4)`:
     - `ikm = transcriptHash`
     - `salt = host.nonce || client.nonce`
     - `info = Buffer.concat([Buffer.from('NOX-LINK-SAS-V3'), lp(roomId), lp(host.deviceName), lp(client.deviceName)])`
   - Преобразование 32-битного unsigned целого по модулю `1_000_000` (с rejection sampling или 64-битным чтением во избежание смещения модуля — `readUInt32BE(0) % 1_000_000` с 32 бит даёт пренебрежимое смещение `< 0.002%`, либо читаем 64 бита и `(BigInt % 1_000_000n)` для идеального распределения) → 6-значный код `000000..999999`.
   - На экранах **обоих** ПК показываются: **6-значный код SAS**, **имя удалённого устройства (`deviceName`)**, **укороченный `deviceId`** и **префикс `roomId`**.
   - **Никакого автоматического доверия:** пир записывается в `peers.json` (с `rootCaPem`, `rootCaFp256`, `leafFp256`, `deviceName`, `pairedAt`) только после того, как **оба** владельца нажали подтверждение и обменялись `{ type: 'sas_confirm', ok: true, transcriptHash }` внутри mTLS. При отмене или расхождении кода (`sas_abort`) ключи сеанса удаляются, комната закрывается.

### 2.4. Ограничения попыток и отзыв устройств (Revocation)

- **Rate limiting на `apps/nox-server`** (по схеме `allowAttempt` / `tooMany` / `recordAttempt` в `apps/nox-server/store.js`):
  - Не более `5` неудачных попыток создания/подключения к комнатам или провала SAS за `15 минут` на `(accountId)` и на `(IP)` → ответ `429 Retry-After`.
  - Не более `1` активной комнаты сопряжения на пару `(hostDeviceId, clientDeviceId)` и не более `3` открытых комнат одновременно на `accountId`.
  - Общий TTL сопряжения: `PAIR_TTL_MS = 120_000` (непродлеваемый).
- **Локальное ограничение:** после `3` отмен / несовпадений SAS от одного устройства клиент накладывает локальный cooldown `5 минут` (`300_000 мс`) на новые запросы от этого `deviceId`.
- **Механизм отзыва устройства (3-уровневый):**
  1. **На сервере:** `POST /v1/link/devices/:deviceId/revoke` (требует `Authorization: Bearer <accountToken>`). Сервер выставляет `revoked_at = now` в `link_devices`, удаляет все ожидающие билеты комнат с этим устройством, немедленно рвёт активные relay-пайпы для `deviceId` и рассылает SSE `link.device.revoked` всем онлайн-устройствам аккаунта.
  2. **На втором ПК (инициаторе отзыва или получателе SSE):** запись в `peers.json` **не удаляется бесследно**, а получает tombstone `{ revokedAt: now, revokedBy: 'owner' | 'server_sync' }`. Наличие `revokedAt` гарантирует отказ при любых повторных попытках подключения до нового полного сопряжения с новым SAS.
  3. **В момент выполнения:** активный TLS-сокет немедленно закрывается (`destroy()`), а запущенный на приёмной стороне удалённый агент прерывается через `AbortController.abort('peer_revoked')`.

---

## 3. Защита от повторов, статусы, таймауты и восстановление после сбоев

### 3.1. Устранение конфликта TTL и ограниченного списка `seen`

В Revision v2 была критическая логическая ошибка: проверка свежести `createdAt` требовала отсекать старые сообщения по времени, но при этом `seen.json` представлял собой кольцевой буфер на `MAX_SEEN_IDS = 2000` записей без привязки к времени. Если злоумышленный или сбойный пир присылал 2001 уникальное сообщение в течение окна TTL, самые старые всё ещё свежие `msgId` вытеснялись из `seen` и снова становились пригодны для повторного воспроизведения (replay). Кроме того, v2 путал `60 секунд` и `24 часа`.

**Инварианты времени и дедупликации в Revision v3:**
1. Единые константы:
   - `MESSAGE_TTL_MS = 60_000` (сообщение старше 60 с отвергается).
   - `MAX_CLOCK_SKEW_MS = 15_000` (допустимое расхождение часов вперёд).
   - Допустимое окно приёма `createdAt`: `[now - 60_000, now + 15_000]`. Любое сообщение вне этого окна отклоняется (`reason: 'expired' | 'clock_skew'`) **до** записи в `seen`.
   - **Математический инвариант удержания:**
     $$\text{SEEN\_RETENTION\_MS} \ge 2 \times (\text{MESSAGE\_TTL\_MS} + \text{MAX\_CLOCK\_SKEW\_MS}) = 150\_000\text{ мс}$$
     В реализации задаётся `SEEN_RETENTION_MS = 300_000` (5 минут, что с запасом перекрывает окно свежести и допустимый рассинхрон часов).
2. **Запрет досрочного вытеснения по счётчику:**
   - Запись `{ peerId, msgId, seenAt }` **запрещено удалять**, пока `now - seenAt < SEEN_RETENTION_MS`.
   - Очистка `seen` выполняется **только по истечении возраста** (`now - seenAt >= SEEN_RETENTION_MS`).
3. **Защита диска/RAM при флуде (Rate limit вместо вытеснения):**
   - Лимит активных записей на одного пира: `MAX_ACTIVE_SEEN_PER_PEER = 5_000` (и глобальный лимит `20_000`).
   - Если после очистки просроченных записей число активных `msgId` за последние 5 минут достигло `MAX_ACTIVE_SEEN_PER_PEER`, приёмник **не вытесняет старые записи**, а **отклоняет новые сообщения** статусом `rate_limited` до естественного истечения `SEEN_RETENTION_MS`.
4. **Строгий формат `msgId` и порядковый номер сеанса:**
   - `msgId` принимается только в формате строгого UUIDv4 в нижнем регистре (`/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`).
   - Каждый кадр `task_submit` дополнительно несёт строго возрастающий в пределах текущего TLS-сеанса `seq` (начинается с `1`, повтор или откат `seq` обрывает сеанс как нарушение протокола).
   - Запись `msgId` в `seen.json` и записи задачи в `link-jobs.json` выполняется **синхронно атомарно (`writeTemp -> fsync -> rename`) до отправки `ack`** и до старта агента.

### 3.2. Разделение статусов: доставка, выполнение, подтверждённый результат

Прототип `device.js` в строке 191 возвращал `{ ack: m.msgId, status: 'done' }` сразу при приёме сообщения. В Revision v3 протокол строго разделяет три фазы, ни одна из которых не имеет права подменять другую:

| Фаза | Кадр (NDJSON) | Значения и смысл | Гарантии |
|---|---|---|---|
| **1. Запрос** | `task_submit` | `{ v: 3, type: 'task_submit', seq, msgId, createdAt, text }` | `text <= 16_384` байт UTF-8 |
| **2. Доставка / Приёмка (Admission)** | `ack` | `{ v: 3, type: 'ack', msgId, deliveryStatus, reason? }` <br> `deliveryStatus`: `'accepted' \| 'duplicate_completed' \| 'duplicate_in_progress' \| 'duplicate_interrupted' \| 'rejected'` | Отправляется **только после** проверки подписи/пина TLS, отсутствия отзыва, схемы JSON, окна `createdAt`, проверки блокировки Windows (`unlocked`), дедупликации и атомарной записи на диск. **Не блокируется ожиданием `Agent.run`**. |
| **3. Выполнение и Проверка** | `result` | `{ v: 3, type: 'result', msgId, executionStatus, verificationStatus, summary, finishedAt }` <br> `executionStatus`: `'completed' \| 'failed' \| 'stopped' \| 'timeout' \| 'interrupted_by_restart' \| 'aborted_revoked'` <br> `verificationStatus`: `'confirmed' \| 'reads_only' \| 'unverified' \| 'failed' \| 'not_applicable'` | Запрещено возвращать `verificationStatus: 'confirmed'`, если `executionStatus !== 'completed'` или хотя бы один изменяющий инструмент получил `checkEffect !== 'confirmed'`. Если вызваны только `T0` инструменты — честно отдаётся `'reads_only'`. |
| **4. Подтверждение доставки результата** | `result_ack` | `{ v: 3, type: 'result_ack', msgId }` | Позволяет приёмнику пометить исходящий результат в `link-jobs.json` как доставленный и не держать его в очереди переотправки. |
| **5. Запрос статуса после обрыва** | `task_status` | `{ v: 3, type: 'task_status', msgId }` | При обрыве связи во время выполнения ПК #1 может узнать итог без повторной отправки `task_submit` и без риска повторного запуска. |

### 3.3. Обработка некорректного JSON, таймауты и корректное закрытие соединений

- **Строгий NDJSON-фрейминг:**
  - Лимит длины строки `MAX_LINE_BYTES = 65_536` проверяется **по количеству байт в `Buffer` (UTF-8)**, а не по `.length` UTF-16 строки.
  - Переполнение буфера строки немедленно останавливает чтение потока (`socket.pause()`), отправляет `{ v: 3, type: 'error', code: 'frame_too_large' }`, ставит закрытие `socket.end()` и принудительный `socket.destroy()` через `100 мс`.
- **Обработка malformed JSON и валидация схемы:**
  - `JSON.parse` в `try/catch`; проверяется `typeof frame === 'object' && frame !== null && !Array.isArray(frame)`.
  - Исключаются опасные ключи (`__proto__`, `constructor`, `prototype`), проверяется `frame.v === 3`, допустимый `type` и точные типы/ограничения всех полей.
  - При синтаксической ошибке JSON приёмник отправляет структурированный отказ `{ v: 3, type: 'error', code: 'malformed_json' }` и увеличивает счётчик ошибок сеанса (порог `3` ошибки → корректное закрытие `socket.end()`); для ошибочных по схеме кадров с валидным `msgId` возвращается `{ v: 3, type: 'ack', msgId, deliveryStatus: 'rejected', reason: 'invalid_schema' }`.
- **Нормированные таймауты:**
  - `RELAY_WAIT_TIMEOUT_MS = 15_000` (сервер-посредник закрывает комнату, если не собрались 2 участника).
  - `TLS_HANDSHAKE_TIMEOUT_MS = 10_000` (обрыв зависшего TLS-рукопожатия).
  - `DELIVERY_ACK_TIMEOUT_MS = 5_000` (отправитель не дождался `ack` на `task_submit`).
  - `HEARTBEAT_INTERVAL_MS = 15_000` (`{ v: 3, type: 'ping', ts }` → `{ v: 3, type: 'pong', ts }`) и `IDLE_READ_TIMEOUT_MS = 45_000` (отсутствие любых кадров/pong → чистый обрыв и перевод канала в offline).
  - `TASK_EXECUTION_TIMEOUT_MS = 120_000` (ограничение длительности `Agent.run` через `AbortController` → `executionStatus: 'timeout'`).
- **Корректное закрытие (Graceful Teardown):**
  - При `close` / `end` / `shutdown` очищаются все таймеры, все ожидающие промисы в `pending` (для `ack` и `task_status`) завершаются ошибкой `connection_closed`, вызывается `tlsSocket.end()` с fallback-таймером `500 мс` до `tlsSocket.destroy()` и закрытием нижележащего `raw` relay-потока.
  - На событие Electron `before-quit` все активные удалённые задачи прерываются через `AbortController`, состояния фиксируются на диске, соединения закрываются.

### 3.4. Безопасное восстановление после перезапуска и приватность журналов

- **Журнал состояния задач `<DATA_DIR>/link/link-jobs.json`:**
  - Каждая принятая задача ведётся по конечному автомату: `accepted` → `running` → (`completed` | `failed` | `stopped` | `timeout` | `interrupted_by_restart` | `aborted_revoked`).
  - Запись изменений на диск выполняется атомарно (`writeTemp -> fsync -> rename`).
  - **Защита от утечки чувствительных текстов:** сырой текст входящего запроса (`text`) **не пишется в `diag.log`** и не хранится бессрочно на диске (в `link-jobs.json` сохраняются только `msgId`, `peerId`, `receivedAt`, `executionStatus`, `verificationStatus`, урезанный санитизированный `summary <= 512 Б` до получения `result_ack`, TTL хранения готовой записи в журнале — `24 ч`).
- **Алгоритм восстановления при старте (`recoverLinkStateOnBoot()`):**
  1. До открытия входящих сеансов считываются `seen.json` и `link-jobs.json`.
  2. Из `seen.json` отфильтровываются только те записи, где `now - seenAt >= SEEN_RETENTION_MS`; все записи внутри 5-минутного окна сохраняются — повторная доставка старых `msgId` после рестарта невозможна.
  3. Любая задача в `link-jobs.json`, оставшаяся в состоянии `accepted` или `running` от прошлого процесса, переводится в `executionStatus: 'interrupted_by_restart'`, `verificationStatus: 'not_applicable'`.
  4. **Жёсткий запрет тихого перезапуска:** приёмник **НИКОГДА** не запускает `Agent.run` повторно после рестарта без нового явного запроса пользователя с новым `msgId`. Если ПК #1 переподключится и спросит `task_status(msgId)`, он честно получит `executionStatus: 'interrupted_by_restart'`.

---

## 4. Изоляция удалённого агента

### 4.1. Строгий белый список через отдельный `ToolRegistry`

Паттерн `apps/jarvis-desktop/src/telegram/policy.js` (`remoteAllowed`: фильтрация полного списка инструментов по `RISK_OK` + regex-чёрный список `BLOCKED`) и `buildRemoteAgent` в `main.js` (использующий `mode: 'full'`) **категорически запрещены** для Nox Link. Любой новый инструмент, добавляемый в приложение для владельца (включая параллельную разработку С5), не должен случайно стать доступным с другого ПК.

- Для каждого удалённого пира создаётся **отдельный экземпляр `new ToolRegistry()` (`src/tools/registry.js`) — `linkTools`**.
- Туда регистрируются **только** перечисленные ниже реально существующие безопасные инструменты, привязанные к изолированному `WorkspaceIndex` песочницы пира. `baseTools`, `tools` и `withOwnWorkspace` в удалённого агента **не передаются**.

### 4.2. Полный перечень запрещённого в v1

В версии v1 удалённому агенту **полностью отсутствуют в `ToolRegistry`** (и физически недоступны):
1. **Все сетевые и внешние инструменты:** `web_search`, `web_wiki`, `web_fetch`, `web_research`, `web_check_claims`, `weather_now`, `currency_rate`, `browser_open`, `browser_read`, `browser_scroll`, `browser_click`, `browser_type`, `url_open`, `mail_send`, `mail_unread`, `youtube_play`, `calendar_upcoming`, `calendar_briefing`, а также сам `link_send` (запрет транзитивного перескока на третий ПК) и любые MCP-инструменты.
2. **Доступ к экрану, изображениям и голосу:** `screen_look`, `screen_region_look`, `image_look`, `image_read_text`, `speak`, `read_clipboard_aloud`.
3. **Буфер обмена:** `clipboard_get`, `clipboard_set`, `read_clipboard_aloud`.
4. **Общая память, чаты, задачи, навыки и инвентарь:** `remember`, `recall`, `memory_about`, `forget`, `deals_hanging`, `deal_clear`, `deal_add`, `goal_*`, `remind_in`, `remind_at`, `list_reminders`, `cancel_reminder`, `mission_add`, `mission_list`, `mission_cancel`, `command_create`, `command_list`, `command_set_hotkey`, `command_build`, `skills_list`, `skill_read`, `apps_find`, `apps_scan`, `apps_usage`, `code_read`, `code_write`, `code_edit`, `code_test`, `project_brief`, `project_commands`, `project_run`, `project_diagnostics`, `agents_parallel`.
5. **Управление Windows, процессами и PowerShell:** `shell_run`, `app_open`, `app_close`, `app_search`, `app_install`, `pc_shutdown`, `monitor_off`, `volume_set`, `screen_brightness`, `media_control`, `wait`, `wait_for` *(использует PowerShell для окон/процессов)*, `disk_free_space` и `disk_cleanup_suggest` *(в коде `src/tools/disk.js` оба вызывают `runPowerShell`!)*, `desktop_observe`, `desktop_click`, `desktop_type`, `mouse_click`, `mouse_scroll`, `ui_*`, `windows_*`, `windows_close_all`, `window_close_active`, `organize_workspace`, `restore_workspace`.
6. **Несуществующие инструменты, ошибочно указанные в v2:** `system_info`, `time_now`, `battery_status`, `network_status`, `calc`, `note_save` удалены из архитектуры (в `apps/jarvis-desktop/src/tools/` их нет).
7. **Сложные бинарные парсеры в v1:** `document_read` (PDF/DOCX/XLSX через `pdfjs-dist` и `zip.js`), `document_write`, `document_fill`, `workspace_move`, `workspace_copy`, `workspace_restore` в v1 также исключаются для минимизации поверхности атаки.

### 4.3. Минимальный белый список реально существующих безопасных инструментов (v1)

Для пира `peerDeviceId` создаётся **изолированная песочница** `peerSandboxDir = path.join(ROOT, 'link-sandboxes', peerDeviceId)` (строго вне рабочей папки владельца `workspace/` и вне системной `DATA_DIR` / `connectedFolders`), и на ней создаётся изолированный `linkIndex = new WorkspaceIndex(peerSandboxDir)` (`src/rag/index.js`):
- `linkIndex.unrestricted = false` (жёстко зафиксировано, никогда не меняется).
- `linkIndex.folders = []` (`setFolders` с `connectedFolders` владельца **никогда не вызывается**).
- `linkIndex.denyWrite = [DATA_DIR, APP_DIR, OWNER_WORKSPACE_DIR]`.
- Проверка `resolveInside` (на `fs.realpathSync`) отсекает выход за пределы `peerSandboxDir` и через `..`, и через симлинки/junction.

Из `workspaceTools(linkIndex)` (`src/tools/workspace.js`) и `planTools(turnPlanStore)` (`src/tools/plan.js`) в `linkTools` попадают **только**:

| Инструмент (реальное имя в `src/tools/`) | Риск | Режим по умолчанию (`allowSandboxWrite = false`) | При явном включении `allowSandboxWrite = true` у пира |
|---|---|---|---|
| `workspace_list` | `T0` | **Разрешён** (список файлов/папок строго внутри `peerSandboxDir`, без скрытых `.` и `rag/`) | Разрешён внутри `peerSandboxDir` |
| `workspace_read` | `T0` | **Разрешён** (чтение текстовых файлов `TEXT_EXTENSIONS`, ограничение `1 МБ`, строго внутри `peerSandboxDir`) | Разрешён внутри `peerSandboxDir` |
| `workspace_search` | `T0` | **Разрешён** (поиск текста строго внутри `peerSandboxDir`) | Разрешён внутри `peerSandboxDir` |
| `turn_stop` | `T0` | **Разрешён** (честный отказ `impossible`/`needs_human`/`unsure` без обращения к диску/сети) | Разрешён |
| `workspace_write` | `T1` | **Запрещён** (отсутствует в `linkTools`) | Разрешён строго внутри `peerSandboxDir` (только `.md`/`.txt`, перезапись только в `reports/` с бэкапом) |
| `workspace_mkdir` | `T1` | **Запрещён** (отсутствует в `linkTools`) | Разрешён строго внутри `peerSandboxDir` |

### 4.4. Запрет наследования `mode: 'full'`, `ownerText`, taint-сброса и подтверждений владельца

Аудит кода выявил важный факт в `src/agent/loop.js`: в начале каждого `Agent.run` цикл сбрасывает `this._tainted = false; this._foreign = false;` и выставляет taint только после чтения инструмента с `source` из `TAINT_SOURCES`. Входящая же задача по Nox Link **уже сама по себе является недоверенным удалённым вводом** ещё до вызова первого инструмента.

Поэтому при запуске удалённого агента действуют 5 жёстких барьеров:
1. **Отдельный объект конфигурации `Agent`:**
   - `tools: linkTools` (белый список)
   - `memory: null` (никакого чтения/записи SQLite памяти владельца)
   - `approvals: null` (никакого `ApprovalBroker`, диалоги подтверждения владельца не поднимаются и авто-разрешений нет)
   - Эфемерная история хода в памяти (не пишется в `chats` владельца).
2. **Неизменяемая обёртка политики `linkPolicy` (не `decide` напрямую из настроек):**
   - **Никогда не читает `settings.mode`** (даже если у владельца локально включён `mode: 'full'`).
   - Вызов `linkPolicy.decide(tool, args, ctx)` **всегда подменяет контекст** на `{ ...ctx, mode: 'ask', ownerText: '', ownerCommand: false, tainted: true, handsTainted: true }`.
   - Сначала проверяет `LINK_ALLOWED_SET.has(tool.name)` и состояние блокировки Windows (см. §4.5); затем сверяет разрешения песочницы: допускаются только `T0` из белого списка (плюс `workspace_write`/`workspace_mkdir`, если явно включён `allowSandboxWrite` для этого пира). Все `T1`/`T2`/`T3` и любые другие решения `'ask'` **без исключения приводятся к `'deny'`** (так как `approvals === null`).
3. **Изолированный системный промпт:** удалённый агент получает урезанный промпт без инструкций управления Windows, памяти, браузера и без утверждений о полном доступе; текст запроса пира передаётся как ненадёжный вход в отдельном теге/блоке с правилом исполнять только в пределах песочницы.
4. **Двусторонний контроль исходящей передачи (`link_send`, когда будет добавлен в будущем для отправителя):**
   - `link_send` должен быть добавлен в `EGRESS_TOOLS` в `src/policy/modes.js` и учитывать `taint` (`src/policy/taint.js`), чтобы локальный агент на ПК #1 после чтения недоверенных веб-страниц или писем не мог скрытно слить секреты на ПК #2 без подтверждения владельца. (В самом коде `modes.js`/`taint.js` сейчас `link_send` нет — правки этих общих файлов планируются только на финальном этапе интеграции С6).

### 4.5. Fail-Closed проверка состояния блокировки Windows

Аудит `apps/jarvis-desktop/src/control/desktop-lock.js` (строка 33) установил, что сейчас `this.locked = false` при инициализации, а обновляется флаг только асинхронными событиями `powerMonitor.on('lock-screen' / 'unlock-screen')` в `main.js:4616-4624`. Если приложение запущено на уже заблокированном ПК, перезапущено, или событие ОС не пришло, `DesktopLock` ложно считает экран разблокированным!

**Требование Revision v3 для Nox Link (строго Fail-Closed):**
- Вводится трёхзначное состояние блокировки: `'locked' | 'unlocked' | 'unknown'`.
- Начальное состояние процесса **всегда `'unknown'`** (никогда `'unlocked'`).
- Перед приёмом задачи (`ack`) **и** перед каждым вызовом инструмента удалённого агента выполняется синхронизированная с таймаутом `<= 1500 мс` активная проверка рабочего стола Windows (`src/link/lock.js`):
  - Если `powerMonitor` зафиксировал `lock-screen` (и не было последующего `unlock-screen`) → `'locked'`.
  - Иначе выполняется активная проверка сессии Windows через системный вызов Win32 / проверку доступности интерактивного рабочего стола (например, `OpenInputDesktop(0, false, READ_CONTROL)` или отсутствие активного `LogonUI.exe` в текущей сессии через не-пользовательский статический вызов без подстановки строк и с жёстким таймаутом).
  - **Правило допуска:**
    - `'unlocked'` → выполнение в песочнице разрешено.
    - `'locked'` → немедленный отказ (`ack: 'rejected', reason: 'locked'` либо `executionStatus: 'stopped'`).
    - **`'unknown'` (ошибка зонда, таймаут, неизвестная ОС/консольный тест без подтверждения) → ОТКАЗ В ИСПОЛНЕНИИ (`reason: 'lock_unknown'`)!** Исключение для изолированных unit-тестов без Windows UI допускается **только** при явной передаче mock-провайдера состояния блокировки в тестах (`DI`), но **никогда** в боевом коде через авто-фолбэк к `false`.

---

## 5. Матрица рисков P0 / P1 и способы проверки каждого P0

Обозначения статуса:
- **ПРОВЕРЕНО ПРОБОЙ / В АРХИТЕКТУРЕ** — проблема и целевой механизм подтверждены пробой на Electron 44.9.3 BoringSSL + зафиксированы в Revision v3; **производственная реализация С6 ещё не написана**.
- **ОПИСАНО В АРХИТЕКТУРЕ (НЕ РЕАЛИЗОВАНО)** — устранено на уровне проектного решения в v3, код и тесты в `src/link/` и `apps/nox-server/` отсутствуют.

| ID | Направление | Риск и дефект v2/спайка | Уровень | Текущий статус | Конкретный способ проверки исправления (после реализации) |
|---|---|---|---|---|---|
| **P0-1** | X.509 / TLS | Конфликт `CA:FALSE` + `ca: [peer.cert]` в Electron BoringSSL (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`) и опасный `CA:TRUE` на листе в спайке | **P0** | **ПРОВЕРЕНО ПРОБОЙ / В АРХИТЕКТУРЕ** (проверено в `scratch/probe_ca_leaf.js` и `scratch/probe_pkijs.js` на Electron 44.9.3) | Тест под `ELECTRON_RUN_AS_NODE=1 electron.exe`: генерация через `pkijs` Device Root CA (`CA:TRUE, pathlen:0, keyCertSign, NameConstraints`) + Leaf (`CA:FALSE, digitalSignature, serverAuth+clientAuth, SAN`). Проверка: (а) валидный mTLS 1.3 проходит (`authorized=true`); (б) лист с чужим SAN под тем же CA отклонён на TLS; (в) лист с тем же SAN, но другим ключом (без пина) отклонён проверкой `leafFp256`. |
| **P0-2** | X.509 / PKI | Отсутствие `keyEncipherment` конфликта / невалидный `BitString` / самописный ASN.1 DER (`x509.js`) / утечка ключей без `safeStorage` | **P0** | **ПРОВЕРЕНО ПРОБОЙ / В АРХИТЕКТУРЕ** (`pkijs` протестирован; `safeStorage` и `package.json` не менялись) | Unit-тест инспекции полей `X509Certificate` (`ca===false`, `eku` только server+client, отсутствие `keyEncipherment`, положительный 16B serial, проверка DER `KeyUsage` парсингом); тест `identity.js`: при `safeStorage.isEncryptionAvailable() === false` без тестового флага инициализация завершается ошибкой (fail-closed), а не записью открытого ключа. |
| **P0-3** | X.509 / TLS | Ошибочная проверка `getEphemeralKeyInfo()` на серверном `TLSSocket` (всегда `null` в BoringSSL и OpenSSL) | **P1** | **ПРОВЕРЕНО ПРОБОЙ / В АРХИТЕКТУРЕ** | В том же тесте Electron mTLS 1.3: сервер принимает соединение без падения на `getEphemeralKeyInfo()`, одновременно проверяя `getProtocol() === 'TLSv1.3'`. |
| **P0-4** | Посредник | Захват предсказуемой комнаты `/link/A~B` посторонним клиентом, отсутствие auth на `relay.js`, DoS висячими слотами | **P0** | **ОПИСАНО В АРХИТЕКТУРЕ (НЕ РЕАЛИЗОВАНО)** | Интеграционный тест `apps/nox-server`: (а) `Upgrade: nox-link` без Bearer или с токеном другого аккаунта → `401/403`; (б) попытка зайти в комнату с чужим/повторным/истёкшим `joinTicket` → `403/409`; (в) 3-й клиент при двух занятых слотах отклонён (`409`), живой пайп 1↔2 не разорван; (г) таймаут ожидания 2-го участника 15 с закрывает комнату. |
| **P0-5** | Сопряжение | Несвязанный SAS v2 (без `roomId`, `deviceName`, полного транскрипта и PoP); гонка раскрытия до Commit | **P0** | **ОПИСАНО В АРХИТЕКТУРЕ (НЕ РЕАЛИЗОВАНО)** | Unit/интеграционные тесты `pairing.js`: (а) подмена `deviceName` или `roomId` на одной стороне при совпадающих `cert`/`nonce` меняет SAS и роняет проверку транскрипта; (б) попытка отправить Reveal без предварительного Commit отвергается; (в) подмена несовпадающего закрытого ключа проваливает PoP/mTLS ещё до показа SAS; (г) 5 неверных попыток дают `429` и cooldown. |
| **P0-6** | Сопряжение | Отсутствие механизма обнаружения ожидания вторым ПК и отзыва устройства | **P0** | **ОПИСАНО В АРХИТЕКТУРЕ (НЕ РЕАЛИЗОВАНО)** | Сквозной тест `nox-server` + 2 клиента: ПК #1 вызывает `sessions/open`, ПК #2 получает событие по SSE `GET /v1/link/events` (и fallback `GET /v1/link/pending`) без открытых портов; после `POST /v1/link/devices/:id/revoke` активный relay-пайп рвётся, `AbortController` прерывает `Agent.run`, переподключение невозможно даже с валидными старыми TLS-ключами. |
| **P0-7** | Анти-повтор | Конфликт TTL (60 с / 24 ч) и кольцевого вытеснения `MAX_SEEN_IDS = 2000` (возможность replay при >2000 сообщений в окне TTL) | **P0** | **ОПИСАНО В АРХИТЕКТУРЕ (НЕ РЕАЛИЗОВАНО)** | Стресс-тест `seen` дедупликации: отправка 5000 уникальных `msgId` в пределах 10 секунд — 5001-е сообщение получает `rate_limited`, при этом повтор `msgId #1` внутри `SEEN_RETENTION_MS = 300_000 мс` по-прежнему отклоняется как `'replay'` (ни одна свежая запись не вытеснена!); после сдвига мок-часов `> 300_000 мс` очистка срабатывает по возрасту, а сам `msgId #1` всё равно отсекается по `createdAt` TTL (60 с). |
| **P0-8** | Протокол и сбои | Смешение `ack`/`done`, отсутствие таймаутов, зависание сокета на плохом JSON, тихий повторный запуск после перезапуска | **P0** | **ОПИСАНО В АРХИТЕКТУРЕ (НЕ РЕАЛИЗОВАНО)** | (а) Инъекция битого JSON, строки `> 64 КБ`, пропущенного/повторного `seq` → корректный error-фрейм, таймаут/закрытие без утечек таймеров и сокетов; (б) эмуляция долгого `Agent.run`: `ack: 'accepted'` приходит мгновенно, `result` позже с `verificationStatus`; если один инструмент не подтверждён (`unknown`), `verificationStatus !== 'confirmed'`; (в) kill процесса во время `running` → при старте `recoverLinkStateOnBoot()` переводит задачу в `interrupted_by_restart`, `Agent.run` не вызывается, запрос `task_status` отдаёт честный статус. |
| **P0-9** | Изоляция | Наследование `mode: 'full'`, чёрный список вместо белого, несуществующие и сетевые/OS-инструменты, общая папка и память | **P0** | **ОПИСАНО В АРХИТЕКТУРЕ (НЕ РЕАЛИЗОВАНО)** | Аудит `linkTools.list()` в тестах: в списке строго ≤ 4 (`T0`) или ≤ 6 (при `allowSandboxWrite`) инструментов, 0 инструментов сети/экрана/буфера/памяти/PowerShell/Windows; тест prompt-injection: даже при глобальном `settings.mode = 'full'` и поддельных опциях `{ ownerText: 'удали ...' }` попытка вызвать любой `T1`/`T2` вне песочницы или прочитать `../workspace` / `connectedFolders` / симлинк наружу возвращает отказ `linkPolicy`. |
| **P0-10** | Изоляция | `DesktopLock.locked` стартует с `false` (не fail-closed при неизвестном состоянии блокировки Windows) | **P0** | **ОПИСАНО В АРХИТЕКТУРЕ (НЕ РЕАЛИЗОВАНО)** | Unit-тесты `lock.js`: (а) при ошибке/таймауте зонда ОС возвращается `'unknown'`, задача получает отказ `lock_unknown`; (б) при состоянии `'locked'` задача отклоняется на приёме; (в) если экран заблокировался во время `Agent.run`, следующий шаг инструмента блокируется и ход прерывается; (г) выполнение допускается только при явном `'unlocked'`. |
| **P1-1** | Наблюдаемость | Утечка текста удалённых задач в `diag.log` и бесконечное хранение промптов в `link-jobs.json` | **P1** | **ОПИСАНО В АРХИТЕКТУРЕ (НЕ РЕАЛИЗОВАНО)** | Тест логгера и `link-jobs.json`: секретный маркер из `task_submit.text` не попадает в `diag.log`, а готовые записи `link-jobs.json` очищаются через 24 ч без хранения сырого `text`. |

---

## 6. Минимальный безопасный план реализации (не затрагивая С5)

Реализация выполняется строго поэтапно с приёмкой тестами на каждом шаге; общие файлы приложения (`main.js`, `preload.js`, `renderer/*`, `src/policy/modes.js`) не затрагиваются до финального этапа, чтобы не конфликтовать с параллельной разработкой С5 (Terra):

- **Этап 0 (Предпосылка, требует согласия владельца):**
  - Получить разрешение владельца на добавление уже имеющихся в lock-файле `pkijs@^3.4.3` (`BSD-3-Clause`) и `asn1js@^3.1.0` (`BSD-3-Clause`) в `"dependencies"` файла `apps/jarvis-desktop/package.json`.
- **Этап 1 (Сервер-посредник в `apps/nox-server` — автономно):**
  - Миграция SQLite (`link_devices`, `link_rooms`, лимиты попыток `allowAttempt`), маршруты `/v1/link/devices/*`, `/v1/link/pairings/start`, `/v1/link/sessions/open`, SSE `/v1/link/events`, `GET /v1/link/pending`, аутентифицированный `Upgrade: nox-link` с одноразовыми билетами и 15 с таймаутом ожидания.
  - Покрыть автотестами в `apps/nox-server/tests/link-relay.test.js` (P0-4, P0-6 серверная часть).
- **Этап 2 (Криптография, протокол и сопряжение в изолированной папке `apps/jarvis-desktop/src/link/`):**
  - Модули: `identity.js` (2-tier PKI на `pkijs` + `safeStorage` fail-closed), `tls.js` (mTLS 1.3 + пиннинг `rootCaFp256` и `leafFp256`), `pairing.js` (Commit-then-Reveal, PoP, транскрипт-привязанный SAS), `protocol.js` (NDJSON 64KB, валидация, раздельные `ack` / `result` / `result_ack` / `task_status`, таймауты, keepalive), `seen.js` и `jobs.js` (`SEEN_RETENTION_MS = 300_000`, `rate_limited` без вытеснения, восстановление `interrupted_by_restart`).
  - Покрыть тестами на Electron (`ELECTRON_RUN_AS_NODE=1`) и локальном тестовом `nox-server` без UI (P0-1, P0-2, P0-3, P0-5, P0-7, P0-8, P1-1).
- **Этап 3 (Изоляция агента и блокировка Windows в `src/link/sandbox.js`, `policy.js`, `lock.js`):**
  - Строгий белый список `ToolRegistry` поверх песочницы `ROOT/link-sandboxes/<peerDeviceId>`, независимый `linkPolicy` с принудительным `mode: 'ask'`, `ownerText: ''`, `tainted: true`, `approvals: null`, fail-closed проверка блокировки Windows (`'locked' | 'unlocked' | 'unknown'`).
  - Покрыть тестами изоляции, промпт-инъекций, симлинков и сбоев зонда блокировки (P0-9, P0-10).
- **Этап 4 (Управляемая интеграция в `main.js`, `preload.js`, `modes.js`, `taint.js` и UI — после согласования с С5):**
  - Подключение `src/link/` за явным флагом настроек (`linkEnabled: false` по умолчанию), добавление `link_send` в `EGRESS_TOOLS`/`TAINT_SOURCES`, обновление `AGENTS.md` (требуется тестом `project-map.test.js`), UI подтверждения SAS и отзыва устройств.
  - Живая проверка в настоящем окне Electron (два изолированных `NOX_DATA_DIR` профиля).

---

## 7. Вердикт GO / NO-GO

| Объект решения | Вердикт | Основание (доказательства) |
|---|---|---|
| **Переработанная спецификация (Revision v3)** | **GO для начала Этапа 1–2 (после одобрения владельца по `pkijs`)** | Все 4 направления блокеров Fable 5.2 устранены без внутренних противоречий; совместимость 2-уровневой X.509 схемы (`pkijs` CA + `CA:FALSE` Leaf + `NameConstraints` + пиннинг) с Electron 44.9.3 BoringSSL и поведение `getEphemeralKeyInfo()` **доказаны** пробами на реальном бинарнике Electron. |
| **Запуск С6 (Nox Link) в основном приложении / включение пользователям** | **NO-GO** | На момент аудита код `apps/jarvis-desktop/src/link/*` и маршруты `apps/nox-server` для С6 **не реализованы**, `pkijs` остаётся dev-зависимостью, `DesktopLock` по умолчанию стартует с `locked = false`, а доказаны пока только базовые TLS/X.509 примитивы в изоляции (все остальные P0–P1 механизмы — сопряжение, SAS, защита ретранслятора, анти-повтор, восстановление, белый список и fail-closed блокировка — находятся в статусе «спроектировано, требует реализации и тестов»). |
