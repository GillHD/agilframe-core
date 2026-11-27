# Сборка и CI

JavaScript и TypeScript собираются из корня репозитория. Workspaces используют общий lockfile.

```sh
npm ci
npm run build
npm run typecheck
npm test
node agil/core/scripts/e2e.mjs --only=api
```

Сборка создаёт `dist/` для общих пакетов и статических интерфейсов. Проверка типов и часть тестов используют эти артефакты. После обновления зависимостей сохраняйте изменения `package-lock.json`.

В `.github/workflows/` находятся проверки JavaScript, Android, iOS, Flutter, Capacitor и React Native. Контейнеры можно собрать локально из Dockerfile и проверить по [руководству развёртывания](deployment.md). [Подготовка публикации](../../../docs/release/README.md)
