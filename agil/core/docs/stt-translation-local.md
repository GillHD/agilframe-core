# Локальные STT и перевод (v2, free/open-source)

Дата обновления: 27.11.2026. **модели и бинарники не
входят в репозиторий** и не скачиваются автоматически: по умолчанию
доступность проверяется только по локальным файлам. Явный opt-in на
однократную загрузку весов STT — `AGIL_STT_ALLOW_DOWNLOAD=1`. Документ описывает,
как включить on-box распознавание речи (RU/EN) и машинный перевод, какие
ресурсы для этого нужны и что именно остаётся внешним.

Связанные документы: [features.md](features.md), [provider-adapters.md](provider-adapters.md),
[free-open-source-plan.md](free-open-source-plan.md).

## 1. Что сделано

- `STT_PROVIDER=local` — серверное распознавание на своём железе:
  - **whisper.cpp** (`whisper-cli`, MIT) — CLI на чанк, CPU или CUDA/Metal;
  - **faster-whisper** (CTranslate2, MIT) — долгоживущий Python-воркер,
    модель остаётся в RAM/VRAM между чанками.
- `TRANSLATE_PROVIDER=local` — машинный перевод RU↔EN:
  - **OPUS-MT** от Helsinki-NLP. `ru-en` — CC BY 4.0, `en-ru` — Apache-2.0.
    Для обеих моделей используйте [уведомления и ссылки на лицензии](model-licenses.md).
  - **MarianMT** использует ту же структуру каталогов. У собственных весов
    проверяйте отдельную лицензию.
- `TRANSLATE_PROVIDER=llm` — **опциональный платный/self-hosted** адаптер через
  `UniversalLlmClient`; выключен по умолчанию и запрещён при `PRIVACY_MODE=local`.
- `TRANSLATE_PROVIDER=none` — перевод выключен, UI не обещает перевод.
- Чанковая схема: виджет отправляет ~8-секундные `MediaRecorder`-чанки
  (webm/opus) на `POST /v1/stt/transcribe`; сервер конвертирует в 16 kHz mono WAV
  через `ffmpeg` и возвращает сегменты с абсолютными таймстемпами (`offsetSec`).
  Сторонний клиент передаёт смещение чанка заголовком `x-chunk-offset` (секунды);
  виджет компенсирует смещение на клиенте и заголовок не отправляет.
- Готовность честная: `available:true` когда движок и веса готовы
  (faster-whisper — CTranslate2 `model.bin`; OPUS-MT — `config.json` + веса в
  обоих направлениях). `ffmpeg` — отдельный
  флаг: `ffmpeg:false` + `code:"ffmpeg_missing"` означает, что WAV-чанки
  принимаются, а браузерные webm/opus — нет.
- Никакого сетевого egress по умолчанию: `availability()` и первый запрос не
  обращаются к HuggingFace. `AGIL_STT_ALLOW_DOWNLOAD=1` разрешает загрузку весов
  распознавания. Локальный перевод всегда читает веса с диска.
- Таймстемпы, RU/EN, автоопределение языка (в ответе — только `ru`/`en`).
- Перевод прикрепляется к каждому сегменту; сбой перевода **не удаляет**
  расшифровку, а попадает в `notice`. Повторный перевод той же строки в течение
  60 с берётся из серверного кэша (REST-ответ STT + follow-up WS-кадр не
  переводятся дважды).
- Consent и retention на уровне тенанта: согласие участника, TTL сегментов,
  удаление сегментов при отзыве согласия. Если комната уже закрыта, а согласие
  требуется, транскрипция отклоняется `403 consent_required` (нельзя проверить
  сохранённое согласие).
- REST/WS:
  - `POST /v1/stt/transcribe` (join token, `x-language`, `x-translate-to`,
    `x-chunk-offset`);
  - `GET /v1/rooms/:roomId/transcript` (таймстемпы, перевод, политика);
  - `GET /v1/rooms/:roomId/transcript/consent` (статус согласия для текущего участника);
  - `POST /v1/rooms/:roomId/transcript/consent` (`{granted:true|false}`);
  - `POST /v1/rooms/:roomId/transcript/translate` (перевод одной строки);
  - `GET /v1/admin/stt` (честный статус: коды причин, basename моделей, флаги;
    без ключей и абсолютных путей);
  - WS `caption` → follow-up кадр `caption` с `translation`/`translated:true`.
- UI: субтитры, панель транскрипта с пометкой «машинный перевод», запрос
  согласия, честное сообщение «перевод недоступен».
- Тесты без моделей: детерминированные `FakeSttEngine` / `FakeTranslator`.

## 2. Провайдеры и приоритеты

| Переменная | Значения | По умолчанию | Смысл |
|---|---|---|---|
| `STT_PROVIDER` | `local` \| `browser` \| `none` \| `remote` | `remote` | `browser` — Web Speech API; `remote` — legacy `AGIL_STT_URL` |
| `TRANSLATE_PROVIDER` | `local` \| `llm` \| `none` | `none` | `llm` — опциональный внешний/self-hosted чат |
| `PRIVACY_MODE` | `standard` \| `local` | `standard` | `local` запрещает внешние STT/MT/LLM |
| `TRANSCRIPT_CONSENT_REQUIRED` | `0`/`1` | `0` | глобальное требование согласия |
| `TRANSCRIPT_RETENTION_SEC` | секунды | `0` | `0` = на время жизни комнаты |
| `AGIL_STT_ALLOW_DOWNLOAD` | `0`/`1` | `0` | Явный opt-in: разрешить загрузку весов STT с HuggingFace, если их нет на диске. `0` = только локальные файлы (сеть не используется). |

Приоритет политики: значение тенанта (`session.transcription.*`) важнее
глобального env; `x-translate-to` переопределяет `translateTo` тенанта **только
при `features.translation=true`**. Если фича перевода выключена, заголовок
игнорируется (перевод не выполняется), а `none` всегда выключает перевод.

### STT: `whisper-cpp` или `faster-whisper`

| | whisper.cpp | faster-whisper |
|---|---|---|
| Бинарник | `whisper-cli` + `ffmpeg` | Python 3 + `faster-whisper` + `ffmpeg` |
| Модель | `ggml-*.bin` | CTranslate2 model id/каталог |
| Запуск | процесс на чанк | один долгоживущий воркер |
| CPU | хорошо, 4–8 потоков | лучше (int8), меньше RAM |
| GPU | CUDA/Metal build | CUDA float16 |
| Плюс | минимум зависимостей | модель не грузится заново |

`STT_LOCAL_ENGINE=auto` выбирает whisper.cpp, если задан
`STT_LOCAL_MODEL_PATH`, иначе faster-whisper, если задан `STT_LOCAL_MODEL`/
`STT_LOCAL_PYTHON`. Явное значение всегда важнее.

### Перевод: `opus-mt` / `marian`

- Пара: каталог с `ru-en/` и `en-ru/`, каждая — HuggingFace snapshot.
- Длинный текст режется по предложениям (`TRANSLATE_LOCAL_MAX_CHARS`, по
  умолчанию 800) и переводится по частям; результат склеивается по порядку.
- Переводчик сериализован: одновременно выполняется один CPU-тяжёлый запрос
  (STT — до двух параллельных), чтобы не перегружать хост.

### Локальные веса и сеть

- faster-whisper: имя (`small`, `medium`, …) или id разрешается в локальный
  каталог через `HUGGINGFACE_HUB_CACHE`/`HF_HOME`/`~/.cache/huggingface/hub`;
  принимается только snapshot с `model.bin` (CTranslate2).
- OPUS-MT: в `ru-en/` и `en-ru/` нужны конфигурация Marian, файлы токенизатора
  `source.spm`, `target.spm`, `vocab.json` и веса.
- Воркер перевода загружает обе модели из локальных каталогов через
  `local_files_only=True`, `HF_HUB_OFFLINE=1` и `TRANSFORMERS_OFFLINE=1`.
- `ffmpeg` обязателен для браузерных webm/opus-чанков; без него
  `/v1/admin/stt` отдаёт `available:true`, `ffmpeg:false`,
  `code:"ffmpeg_missing"` (WAV-путь работает), а `POST /v1/stt/transcribe` с
  webm/opus — `501 ffmpeg_missing` с actionable reason.

## 3. Быстрый старт

### 3.1. Зависимости

```bash
# whisper.cpp: собрать и положить whisper-cli в PATH (или задать STT_LOCAL_BINARY)
# ffmpeg нужен всегда для webm/opus -> WAV
ffmpeg -version

# вариант faster-whisper
python3 -m pip install faster-whisper

# перевод
python3 -m pip install "torch>=2.6" "transformers>=4.51,<5" sentencepiece sacremoses
```

### 3.2. Скачать модели (явно, вручную)

```bash
# из корня репозитория
node agil/core/scripts/local/download-models.mjs --asr small
node agil/core/scripts/local/download-models.mjs --mt pair

# только проверить, что уже лежит на диске (ничего не качает)
node agil/core/scripts/local/download-models.mjs --check --asr small --mt pair
```

Скрипт сохраняет веса в `agil/core/models/`, проверяет SHA-256 весов и
создаёт `MODEL-NOTICE.md` для пары OPUS-MT. Сохраните его вместе с весами
при переносе на изолированный сервер. [Лицензии моделей](model-licenses.md).

### 3.3. Включить на сервере

```bash
STT_PROVIDER=local
STT_LOCAL_ENGINE=whisper-cpp
STT_LOCAL_MODEL_PATH=agil/core/models/whisper/ggml-small.bin
STT_LOCAL_THREADS=4

TRANSLATE_PROVIDER=local
TRANSLATE_LOCAL_ENGINE=opus-mt
TRANSLATE_LOCAL_MODEL_DIR=agil/core/models/translate
```

faster-whisper:

```bash
STT_PROVIDER=local
STT_LOCAL_ENGINE=faster-whisper
STT_LOCAL_MODEL=small
STT_LOCAL_PYTHON=python3
STT_LOCAL_GPU=0
```

Если раньше использовали NLLB, загрузите пару OPUS-MT, установите
`TRANSLATE_LOCAL_ENGINE=opus-mt` и `TRANSLATE_LOCAL_MODEL_DIR`, уберите
`TRANSLATE_LOCAL_MODEL` из окружения Core и перезапустите его. Старый
`AGIL_ALLOW_NC_MODELS` больше не действует. При прежней конфигурации статус
возвращает `translation_model_retired` и команду для миграции.

Загрузка недостающих весов STT на первом запросе (по умолчанию выключена):

```bash
# только если оператор сознательно разрешает сетевой egress на HuggingFace
AGIL_STT_ALLOW_DOWNLOAD=1
```

Проверка: `GET /v1/admin/stt` должен вернуть `stt.configured=true`,
`translation.configured=true` и внятный `reason` при любой проблеме.

### 3.4. Включить в тенанте

```http
PATCH /v1/tenants/demo/config
{
  "features": { "captions": true, "translation": true },
  "session": {
    "transcription": {
      "enabled": true,
      "provider": "server",
      "language": "ru",
      "translateTo": "en",
      "consentRequired": true,
      "retentionSec": 3600
    }
  }
}
```

## 4. API и поведение

### Привязка удалённого STT к узлу

Для собственного HTTP-воркера на отдельном хосте используйте образ `agil/node-stt`.
Подключите каталог модели только для чтения, дождитесь `/readyz` и укажите URL
воркера и ключ в Core. Инструкция включает Compose и параметры порта.
[Отдельный STT-воркер](../nodes/stt/README.md).

В редакторе откройте «Сессия» → «Расшифровка» и укажите **ID узла STT**. Через API это поле `session.transcription.nodeId`. Задайте ID узла своей организации, если настроенный удалённый провайдер зависит от его модуля `stt`. Пустое поле снимает привязку.

Когда модуль недоступен, `POST /v1/stt/transcribe` возвращает `503 stt_node_unavailable` для фрагментов звонка и для файлов. Core не передаёт аудио провайдеру. Открытую расшифровку и сохранённые субтитры можно продолжать читать. Локальное распознавание в процессе с `STT_PROVIDER=local` и распознавание в браузере продолжают работать по своим настройкам. Панель показывает состояние привязанного модуля через `GET /v1/admin/stt`.

### `POST /v1/stt/transcribe`

- Авторизация: join token (`Authorization: Bearer …`).
- Требуется фича `captions` и право роли.
- `Content-Type`: `audio/webm` (по умолчанию), `audio/wav`, `audio/ogg`,
  `audio/mpeg`, `audio/mp4`; до 25 MB.
- `x-language: ru|en` — подсказка движку; без заголовка — авто.
- `x-translate-to: ru|en|none` — переопределить `translateTo` тенанта, только
  если `features.translation=true`; иначе перевод не выполняется.
- `x-chunk-offset: <секунды>` — смещение начала чанка от старта звонка
  (неотрицательное число). Прибавляется к `start`/`end` каждого сегмента; без
  заголовка таймстемпы относительны чанку. Некорректное значение →
  `400 invalid_chunk_offset`.
- Ответ: `text`, `provider:"local"`, `local`, `engine`, `model`, `language`,
  `durationSec`, `segments[]` (`start`,`end`,`text`,`lang`,`translation?`),
  `translation?` (сводка), `notice?`.
- Коды: `501 stt_not_configured` (нет движка/модели — с actionable reason),
  `502 stt_failed` (движок упал), `403 consent_required`, `400
  invalid_chunk_offset`, `429`, `415`.
- Сбой перевода при успешном STT: `200`, сегменты без перевода, `notice` с
  причиной. Расшифровка никогда не теряется из-за перевода.
- Если `features.translation=false`, но клиент прислал `x-translate-to`, перевод
  не выполняется, а в `notice` возвращается явная причина.

### `GET /v1/rooms/:roomId/transcript`

Возвращает сегменты с таймстемпами и `translation`, политику
`translation:{enabled,target,provider,engine}` и
`retention:{retentionSec,consentRequired,consented}`. Retention применяется
лениво при чтении/записи.

### `GET /v1/rooms/:roomId/transcript/consent`

С токеном текущей комнаты возвращает `consentRequired` и `consented` для участника. Виджет запрашивает этот статус перед запуском распознавания. Если требуется согласие, запись аудио начинается после подтверждения от Core.

### `POST /v1/rooms/:roomId/transcript/consent`

`{ "granted": true }` — согласие; `{ "granted": false }` — отзыв, сегменты
этого участника удаляются. Событие пишется в аудит (`transcript.consent`).

### `POST /v1/rooms/:roomId/transcript/translate`

`{ text, sourceLang?, targetLang? }`, до 4000 символов. Нужны фича `captions` и
согласие (если требуется). Ответ `{translation, notice}`. Используется для
браузерного STT и повторного перевода. Коды: `501` перевод выключен, `503`
движок недоступен, `413` слишком длинный текст.

### `GET /v1/admin/stt`

Статус для админки: провайдеры, `configured/available`, `engine`, `model`,
`code`, `ffmpeg`, `localFilesOnly`, `nonCommercial`, причина, consent/retention,
`caveats`. **Не содержит** ключей, токенов, имён пользователей и абсолютных
путей к моделям: только `basename` модели, стабильные коды причин и флаги
(`model_missing`, `ffmpeg_missing`, `model_incomplete`,
`translation_model_retired`, …). Причина отказа всегда actionable.

`caveats` явно сообщают: скачиваются ли веса автоматически
(`AGIL_STT_ALLOW_DOWNLOAD`). Для устаревшего профиля NLLB статус показывает шаги миграции.

Дашборд (`Настройки → STT и машинный перевод`) вызывает этот endpoint и
показывает готовность STT/перевода, причину отказа, consent/retention и
NC-предупреждение.

### WS

Финальный `caption` сначала рассылается без перевода (быстрый путь), затем
follow-up кадр с `translation`, `translationLang`, `translationProvider`,
`translated:true` и тем же `segmentId`. Виджет склеивает кадры по `segmentId`.
Если согласие не получено — `error{code:"consent_required"}`, кадр не
сохраняется.

## 5. Consent, retention, приватность

- Согласие требуется, если `session.transcription.consentRequired` **или**
  `TRANSCRIPT_CONSENT_REQUIRED=1`. До согласия серверный STT отвечает
  `403 consent_required`; виджет показывает запрос и повторяет чанк один раз.
- Если комната уже закрыта/вытеснена, а согласие требуется, `POST
  /v1/stt/transcribe` отвечает `403 consent_required`: сохранённое согласие
  проверить нельзя, поэтому гейт fail-closed. Если согласие не требуется,
  обработка продолжается (сегменты никуда не сохраняются — комнаты нет).
- Отзыв согласия удаляет сохранённые сегменты участника; админ может очистить
  весь транскрипт через `DELETE /v1/admin/rooms/:roomId/transcript`.
- `retentionSec` тенанта (или `TRANSCRIPT_RETENTION_SEC`) — TTL сегментов;
  `0` = до конца жизни комнаты.
- `PRIVACY_MODE=local`:
  - `TRANSLATE_PROVIDER=llm` не создаётся и не вызывается;
  - `STT_PROVIDER=remote` принудительно отключён: `POST /v1/stt/transcribe`
    отвечает `501 stt_not_configured` («PRIVACY_MODE=local allows only
    STT_PROVIDER=local»), а `/v1/admin/stt` показывает `configured:false` и
    причину — даже если `AGIL_STT_URL` задан;
  - whisper.cpp/faster-whisper/OPUS-MT работают локально, аудио и текст не
    покидают хост;
  - браузерный Web Speech API (`STT_PROVIDER=browser`) выполняется на клиенте и
    может использовать облако вендора браузера; для строгой приватности
    используйте `local`, а не `browser`.
- Локальный STT не означает «без-metadata»: в логах есть длительность, движок и
  ошибки, но не аудио и не полный текст (текст хранится только в комнате в
  рамках retention).

## 6. Модели и ресурсы (gates)

Ориентиры для одного хоста; замерять на своём железе. «×real-time» — сколько
секунд аудио обрабатывается за секунду.

| Модель | Диск | RAM/VRAM | CPU (4–8 ядер) | Комментарий |
|---|---|---|---|---|
| whisper.cpp `tiny` | ~75 MB | ~0.4 GB | 5–15× | черновик, много ошибок |
| whisper.cpp `base` | ~142 MB | ~0.6 GB | 3–8× | минимальный приемлемый |
| whisper.cpp `small` | ~466 MB | ~1.0 GB | 1–3× | **базовый RU/EN** |
| whisper.cpp `medium` | ~1.5 GB | ~2.5 GB | 0.3–1× | лучше, нужен CPU |
| faster-whisper `small` int8 | ~0.5 GB | ~1.0 GB | 3–8× | быстрее на CPU |
| faster-whisper `medium` int8 | ~1.5 GB | ~2.5 GB | 1–3× | |
| OPUS-MT пара RU↔EN | ~0.6 GB | ~0.8 GB | зависит от CPU | CC BY 4.0 / Apache-2.0 |

Практические ворота:

- **CPU-only, 4 ядра, 8 GB RAM**: `whisper.cpp small` + OPUS-MT пара — 1–3
  параллельных звонка с 8-секундными чанками; задержка субтитров 1–4 с.
- **8 ядер, 16 GB RAM**: `faster-whisper small int8` + OPUS-MT — 3–8 звонков;
  RAM становится главным ограничением.
- **GPU (≥8 GB VRAM)**: faster-whisper `medium`/`large-v3` float16 + OPUS-MT;
  CPU освобождается, но GPU-модель не делится между процессами.
- Диск: 5–10 GB на все модели + временные WAV-чанки (удаляются после запроса).
- `ffmpeg` — обязателен для браузерного webm/opus; без него принимается только
  `audio/wav` (passthrough, без конвертации), а статус отдаёт
  `available:true`, `ffmpeg:false`, `code:"ffmpeg_missing"` и reason про WAV;
  webm/opus-запрос получает `501 ffmpeg_missing`. Это не блокирует WAV-чанки,
  но и не выдаёт «полную готовность» браузерного пути.
- Модели **не входят** в git/Docker-образ по умолчанию; для офлайн-поставки
  скачайте их на этапе провижининга и смонтируйте каталог.
- Сеть: по умолчанию `availability()` и запросы используют только локальные
  файлы (`local_files_only`, `HF_HUB_OFFLINE=1`). `AGIL_STT_ALLOW_DOWNLOAD=1`
  разрешает загрузку недостающих весов STT. Локальный перевод пользуется
  заранее подготовленными файлами.

## 7. Качество и ограничения

- Это **машинное** распознавание и перевод, не человеческое качество. Имена,
  числа, термины, акценты и перекрывающаяся речь — типовые ошибки.
- Маленькие модели (`tiny`/`base`) заметно хуже на русском; для продакшена
  минимум `small`, лучше `medium`.
- Пунктуация RU приблизительная; диаризация (кто говорит) не поддерживается.
- Таймстемпы — по сегментам, не по словам.
- Это не true-streaming: задержка равна длине чанка + инференс. Уменьшение
  чанка повышает нагрузку и рвёт контекст.
- Перевод идёт после финального сегмента; промежуточные (interim) субтитры не
  переводятся.
- `llm`-перевод может быть качественнее, но это внешний/платный путь и он
  запрещён в `PRIVACY_MODE=local`; качество и стоимость зависят от модели.
- NLLB-200 нельзя использовать в коммерческом продукте (CC-BY-NC-4.0);
  для OPUS-MT соблюдайте условия каждого направления и сохраняйте уведомления.

## 8. Лицензии

| Компонент | Лицензия | Можно коммерчески |
|---|---|---|
| whisper.cpp / faster-whisper / CTranslate2 | MIT | да |
| Whisper weights | MIT | да |
| OPUS-MT (Helsinki-NLP) RU→EN / EN→RU | CC BY 4.0 / Apache-2.0 | да, с применимыми уведомлениями |
| MarianMT | MIT | да |
| ffmpeg | LGPL/GPL (сборка) | зависит от сборки |

## 9. Тесты без моделей

```bash
npm run test -w @agil/ai          # fake engine/translator, chunking, RU/EN
npm run test -w @agil/calls-server # consent, endpoint, WS, status, degradation
npm run typecheck -w @agil/ai
npm run typecheck -w @agil/calls-server
```

Ключевые файлы:

- `packages/ai/test/local-stt.test.ts` — фикстура, offset, недоступность
  бинарника/Python без запуска процессов, проверка `ffmpeg`/локальных весов
  faster-whisper, отсутствие абсолютных путей в reason;
- `packages/ai/test/local-translate.test.ts` — словарь, чанки, локальный
  privacy-refusal, LLM sanitize, полнота OPUS-снапшота, отказ от устаревшего NLLB,
  `local_files_only` по умолчанию, отсутствие путей в reason;
- `apps/server/test/stt-translation.test.ts` — injection `sttEngines` (включая
  реальные адаптеры с заведомо секретными путями), consent/retention,
  `/v1/stt/transcribe` (`x-chunk-offset`, `features.translation=false`),
  `/v1/rooms/:id/transcript*`, `/v1/admin/stt` (коды/NC/скачивание),
  consent при закрытой комнате, дедупликация перевода REST→WS;
- `apps/server/test/providers.test.ts` — legacy remote STT не сломан.

CI не требует ни модели, ни Python, ни `ffmpeg`: фейковые движки внедряются
через `createAgilServer({ sttEngines })`.

Для сквозной проверки с реальным распознаванием задайте `STT_LOCAL_ENGINE`,
путь к модели и Python или `whisper-cli` по инструкции выше. Укажите в
`AGIL_QA_STT_AUDIO` путь к тестовому WAV-файлу с речью, а в `AGIL_QA_STT_PHRASE`
— фразу, которую должен распознать движок. Запустите
`node agil/core/qa/captions-e2e.mjs` после сборки Core, AI и демо. Chromium
подаёт WAV на виртуальный микрофон. Тест проверяет ответ Core и субтитры
у второго участника. С локальными весами используйте
`PRIVACY_MODE=local` и `AGIL_STT_ALLOW_DOWNLOAD=0`.

Чтобы проверить получение субтитров в Firefox, установите Firefox из комплекта
Playwright и добавьте к команде `--firefox-receiver`. Если Playwright установлен
вне проекта, задайте путь к его `index.mjs` в `AGIL_QA_PLAYWRIGHT_MODULE`.
Chromium передаёт речь, Firefox проверяет текст, имя говорящего и положение
субтитров относительно панели звонка при ширине 390 и 320 px. Для сохранения
снимка укажите каталог в `AGIL_QA_SCREENSHOT_DIR`.

Для проверки внешнего STT на отдельном тестовом Core укажите его loopback URL
в `AGIL_QA_CAPTIONS_CORE_URL` и тестовый ключ организации `demo` в
`AGIL_QA_CAPTIONS_CORE_KEY`. Для удалённого стенда подойдёт SSH-проброс на
`127.0.0.1`. Core должен быть запущен с настроенным внешним STT. Сценарий
меняет настройки `demo` и создаёт тестовую комнату, поэтому используйте
экземпляр с отдельным временным хранилищем. WAV и ожидаемая фраза задаются
теми же переменными, что и в локальном сценарии.

Чтобы проверить Firefox как отправителя речи, запустите тот же сценарий
с `--firefox-sender`. Firefox использует тестовый WAV как виртуальную
аудиодорожку и записывает её штатным MediaRecorder. Тест сверяет формат
отправленного фрагмента, текст после распознавания и субтитры у собеседника
в Chromium.

## 10. Диагностика

| Симптом | Причина | Что делать |
|---|---|---|
| `501 stt_not_configured`, «binary not found» | `whisper-cli` не в PATH | собрать whisper.cpp / `STT_LOCAL_BINARY=/abs/path` |
| `501`, `code:"model_missing"` | весов нет на диске (faster-whisper) | запустить downloader, указать локальный каталог или `AGIL_STT_ALLOW_DOWNLOAD=1` |
| `501`, `code:"ffmpeg_missing"` | нет `ffmpeg` | установить ffmpeg / `STT_LOCAL_FFMPEG`; для WAV можно без него |
| `501`, «faster_whisper is not importable» | нет Python-пакета | `python -m pip install faster-whisper`, проверить `STT_LOCAL_PYTHON` |
| `502 stt_failed`, «ffmpeg could not decode» | нет `ffmpeg`/битый чанк | установить ffmpeg, проверить MIME |
| `translation_unavailable`, `code:"translation_model_retired"` | устаревший профиль NLLB | перейти на OPUS-MT по инструкции выше |
| `translation_unavailable`, «TRANSLATE_LOCAL_MODEL_DIR is not set» | не задан каталог | скачать пару, задать env |
| `translation_unavailable`, `code:"model_incomplete"` | пустой/неполный snapshot (нужны `config.json` + веса) | повторный запуск downloader |
| `400 invalid_chunk_offset` | отрицательный/нечисловой `x-chunk-offset` | передать неотрицательные секунды |
| `translation_local_only` | `PRIVACY_MODE=local` + `llm` | использовать `local` |
| Перевод есть, но плохой | маленькая модель/шум | `medium`, гарнитура, проверить направление и качество исходной расшифровки |
| Согласие не запрашивается | `consentRequired=false` | включить в тенанте или env |
| Транскрипт «исчез» | retention истёк | увеличить `retentionSec` |

## 11. Внешние зависимости (что остаётся)

- CPU/GPU и RAM для инференса; качество и лицензии моделей.
- `ffmpeg`/`whisper-cli`/Python-пакеты — ставятся на хост, не в репозиторий.
- Для `TRANSLATE_PROVIDER=llm` — внешний/self-hosted LLM, его ключ и стоимость.
- Для `STT_PROVIDER=remote` — legacy OpenAI-совместимый STT (не бесплатный).
- Деплой, GPU-драйверы, провижининг моделей и мониторинг задержки — вне этого
  адаптера (см. deploy-документацию).

## 12. Не входит в v2

- True-streaming STT и word-level timestamps.
- Диаризация и определение говорящего.
- Автоматический перевод произвольных языков (только RU/EN).
- Встроенные веса моделей, автоскачивание при старте, GPU-планировщик
  (загрузка — только явный `AGIL_STT_ALLOW_DOWNLOAD=1` на первом запросе).
- Гарантия человеческого качества перевода.
