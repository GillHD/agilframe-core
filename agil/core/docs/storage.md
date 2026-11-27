# Хранение файлов: DVC, S3 и форматы

Дата: 16.11.2026. Короткий вывод: **DVC/dvc-s3 — не замена runtime-хранилищу
пользовательских файлов**. Это инструмент версионирования данных и моделей.
Для записей, вложений и транскриптов нужен S3-совместимый `StorageProvider`.

## DVC и dvc-s3

- **DVC** (Data Version Control) — Git-подобное версионирование больших файлов:
  `.dvc`-метаданные в Git, сами данные — в remote (S3/MinIO/SSH).
- **dvc-s3** — плагин remote для S3-совместимого хранилища, не «формат файлов».
- Хорошо: ML-модели, датасеты, QA-фикстуры, демо-ассеты, бэкапы артефактов.
- Плохо для runtime:
  - нет HTTP API загрузки/скачивания;
  - нет multi-tenant ACL и signed URL;
  - нет конкурентной записи и lifecycle;
  - CLI/Git-процесс, не подходит для пользователей;
  - кэш DVC дублирует объекты.

**Итог:** DVC можно использовать в репозитории для моделей Whisper/OPUS и
тестовых данных; для записей/файлов — S3-совместимый адаптер.

## Бэкенды хранения

| Бэкенд | Лицензия | Плюсы | Минусы |
|---|---|---|---|
| Локальный диск | — | просто, быстро | не масштабируется, один хост |
| MinIO | AGPL-3.0 | S3 API, простой, self-hosted | AGPL, ops, лимиты |
| SeaweedFS | Apache-2.0 | S3 API, масштаб, filer | сложнее ops |
| Ceph RGW | LGPL-2.1 | надёжность, масштаб | тяжёлый ops |
| Garage | AGPL-3.0 | лёгкий S3, geo | молодой |
| AWS S3 / R2 / B2 / Wasabi | платно | managed, lifecycle, CDN | цена/egress, vendor |
| NFS / JuiceFS | —/Apache-2.0 | POSIX | не S3, блокировки |
| Git LFS | MIT | версии в Git | не runtime, лимиты |

Рекомендация:

- **локально/тест:** MinIO или SeaweedFS;
- **продакшен:** S3-совместимый managed (S3/R2/B2) или Ceph;
- **модели/фикстуры:** DVC + MinIO/S3;
- **бэкапы:** restic/rclone в S3.

## Форматы

| Данные | Формат | Почему |
|---|---|---|
| Запись звонка | MP4 (H.264 + AAC) | совместимость, монтаж |
| Web-запись | WebM (VP8/Opus) | браузер, размер |
| Трансляция | HLS fMP4 (`.m3u8` + `.m4s`) | CDN, low-latency |
| Аудио для STT | WAV/FLAC 16 kHz mono | качество, Whisper |
| Субтитры | WebVTT + JSONL | браузер + машинная обработка |
| Транскрипт | JSON (сегменты, спикеры) + VTT | API + плеер |
| Whiteboard | JSON + SVG/PNG snapshot | редактирование + превью |
| Чат | JSONL | append-only, экспорт |
| Изображения | WebP/AVIF + PNG fallback | размер/качество |
| Бэкапы | tar.zst + SHA-256 | сжатие, проверка |
| Модели | исходный формат + SHA-256 | DVC/реестр |

## Ключи и метаданные

- Ключ: `tenant/<id>/room/<id>/<kind>/<yyyy>/<mm>/<sha256>.<ext>`.
- Content-addressed: дедупликация, проверка целостности.
- Метаданные (owner, MIME, size, sha256, retention, scan status) — PostgreSQL.
- Signed URL: HMAC, TTL, tenant/room, не публичный bucket.
- Шифрование: SSE-S3/SSE-KMS; для чувствительных — client-side.
- Lifecycle: hot 30 дней → warm 90 → cold/delete; legal hold.
- Антивирус: ClamAV async, quarantine bucket.
- Никаких BLOB в Postgres для записей.

## Что делать

1. Ввести `StorageProvider` (S3 API) + fake/local для тестов.
2. MinIO в quickstart; SeaweedFS — альтернатива.
3. Записи: MP4 + HLS; STT: WAV/FLAC; субтитры VTT.
4. DVC — только для моделей/фикстур, не для пользовательских файлов.
5. Партнёр подключает S3/R2/B2 через адаптер и свои ключи.
