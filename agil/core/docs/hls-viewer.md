# HLS/CDN viewer

Публичная страница для зрителей вебинаров/трансляций, которым не нужно
подключаться к SFU: `/live.html?hls=<playlist>&title=<название>`.

```
https://calls.example.com/live.html?hls=https%3A%2F%2Fcdn.example.com%2Flive%2Findex.m3u8
```

- **Safari/iOS** — нативный HLS (`video.canPlayType`).
- **Chrome/Android/Edge** — `hls.js` (lazy-страница, ~599 КБ, только на `/live.html`).
- `lowLatencyMode`, автоповтор при network-ошибке, кнопка «Повторить», звук по кнопке.
- Страница не получает join-токен и не подключается к комнате: только чтение HLS.
- Тема (`?theme=light|dark`), заголовок, адаптив 390/1440, safe-area, кнопки 44 px.

## Как получить HLS

1. Egress-worker (LiveKit Egress) с `segment_outputs` HLS → файлы/плейлист.
2. Положить плейлист и сегменты на CDN/статический сервер с CORS (или same-origin).
3. Дать зрителям ссылку `/live.html?hls=…`.

Локальная проверка на этом ПК: HLS из `agil/core/qa/egress-local/hls/lab-hls.m3u8` —
`readyState=4`, 1280×720, 6.4 с, 0 ошибок; скриншот
`agil/core/qa/widget/hls-live-viewer.png`.

## Ограничения

- Нет встроенного чата/опросов на HLS-странице (только просмотр).
- Задержка зависит от HLS/CDN (LL-HLS — от egress/плеера).
- Для интерактивных зрителей используйте SFU/вебинарный режим, не HLS.
