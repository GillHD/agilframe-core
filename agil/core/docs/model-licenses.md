# Лицензии моделей AgilFrame

В базовом образе Core нет весов. Локальный перевод скачивает оператор при подготовке окружения. Используемая в продукте языковая пара — русский и английский.

| Задача | Провайдер модели и версия | Лицензия и условия |
| --- | --- | --- |
| Перевод RU → EN | Helsinki-NLP, University of Helsinki. `Helsinki-NLP/opus-mt-ru-en`, ревизия `fbd6dc73284f95536648512cc21d57f19191961a` | CC BY 4.0. Сохраните ссылку на источник, атрибуцию и лицензию. Укажите внесённые изменения, например при конвертации весов. [Карточка модели](https://huggingface.co/Helsinki-NLP/opus-mt-ru-en/blob/fbd6dc73284f95536648512cc21d57f19191961a/README.md) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Перевод EN → RU | Helsinki-NLP, University of Helsinki. `Helsinki-NLP/opus-mt-en-ru`, ревизия `bb09c99d180016eac6819df3dae68edb1690fdee` | Apache-2.0 по карточке этой конкретной ревизии. При поставке сохраните применимые уведомления и приложите текст Apache-2.0. [Карточка модели](https://huggingface.co/Helsinki-NLP/opus-mt-en-ru/blob/bb09c99d180016eac6819df3dae68edb1690fdee/README.md) · [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| Распознавание речи | OpenAI Whisper в формате GGML от `ggerganov/whisper.cpp`, ревизия `5359861c739e955e79d9a303bcbc70fb988958b1` | MIT. При поставке сохраните уведомление об авторских правах и текст лицензии. [Исходная лицензия Whisper](https://github.com/openai/whisper/blob/main/LICENSE) · [Ревизия весов GGML](https://huggingface.co/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1) |
| Распознавание речи, альтернативный воркер | `faster-whisper` с подготовленной моделью CTranslate2. Например, `Systran/faster-whisper-small` | Указанная модель публикуется под MIT. Для поставки своей сборки фиксируйте точную модель и её ревизию. [Карточка faster-whisper-small](https://huggingface.co/Systran/faster-whisper-small) · [Лицензия воркера](https://github.com/SYSTRAN/faster-whisper/blob/v1.2.1/LICENSE) |

Загрузчик выбирает закреплённые ревизии, проверяет SHA-256 файлов весов и сохраняет `MODEL-NOTICE.md` рядом с парой перевода. Если при скачивании контрольная сумма расходится, загрузчик сохраняет предыдущий файл. Команда `--check` проверяет содержимое каталога без сети. При копировании весов в офлайн-дистрибутив включите файлы уведомлений и требуемые тексты лицензий. Лицензии Python-библиотек, базового образа и CDN-ассетов учитываются отдельно.

```bash
node agil/core/scripts/local/download-models.mjs --mt pair
node agil/core/scripts/local/download-models.mjs --mt pair --check
```

Для установок, ранее использовавших NLLB-200, настройте пару OPUS-MT через `TRANSLATE_LOCAL_ENGINE=opus-mt` и `TRANSLATE_LOCAL_MODEL_DIR`. Удалите `TRANSLATE_LOCAL_MODEL` из окружения и перезапустите Core. `GET /v1/admin/stt` показывает миграционную подсказку для старого профиля. Юридическая причина замены — веса NLLB-200 под CC BY-NC 4.0. [Карточка NLLB-200](https://huggingface.co/facebook/nllb-200-distilled-600M) · [Развёртывание STT и перевода](stt-translation-local.md)

## Локальная приёмка

- Прошли 48 целевых тестов пакета AI, Core и админки. В том числе проверены устаревшая конфигурация NLLB, отсутствующие зависимости и согласие на субтитры.
- Через REST проверены оба направления перевода с реальными весами OPUS-MT. Второй участник получил переведённый субтитр через WebSocket.
- `faster-whisper-tiny` распознал тестовую запись «Добрый день. Проверяем работу субтитров». Core вернул перевод «Good afternoon. Checking the subtitles.» и сохранил сегменты в транскрипте. До согласия запрос на перевод был отклонён, после отзыва согласия чтение транскрипта было заблокировано.
- Проверена загрузка закреплённых OPUS-MT и `ggml-tiny.bin` для whisper.cpp с проверкой SHA-256. Сквозной прогон распознавания использовал альтернативный движок faster-whisper.
