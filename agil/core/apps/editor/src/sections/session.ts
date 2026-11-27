/**
 * Session/media section: locales, blur & virtual backgrounds, recording,
 * transcription, file sharing and screen sharing.
 */
import { sessionSchema } from '@agil/protocol';
import { card, renderSchema, tableField, type RenderSchemaOptions, type Sync } from '../fields';
import { tr } from '../i18n';
import type { SectionDefinition } from './types';

const SESSION_LABELS: Record<string, string> = {
  defaultLocale: 'Язык по умолчанию',
  locales: 'Доступные языки',
  allowLocaleSwitch: 'Разрешить смену языка',
  defaultBlurMode: 'Режим фона по умолчанию',
  blurStrength: 'Сила размытия, 1–40',
  virtualBackgrounds: 'Виртуальные фоны',
  joinWithoutPreview: 'Вход без предпросмотра',
  mirrorSelfView: 'Зеркалить своё видео',
  joinWithMicOff: 'Входить с выключенным микрофоном',
  joinWithCamOff: 'Входить с выключенной камерой',
  enabled: 'Включено',
  storeOnServer: 'Хранить на сервере',
  notifyParticipants: 'Сообщать о записи в чате',
  format: 'Формат',
  provider: 'Режим распознавания речи',
  language: 'Язык',
  showCaptionsByDefault: 'Субтитры по умолчанию',
  saveTranscript: 'Сохранять расшифровку',
  translateTo: 'Язык перевода субтитров',
  retentionSec: 'Срок хранения расшифровки, с',
  maxFileSizeMb: 'Макс. размер файла, МБ',
  allowedMimeTypes: 'Разрешённые MIME-типы',
  maxFps: 'Максимум кадров в секунду (FPS)',
  maxWidth: 'Макс. ширина, px',
  shareAudio: 'Делиться звуком',
  preferMotion: 'Приоритет плавности',
  id: 'Идентификатор',
  name: 'Название',
  url: 'URL изображения',
};

const SESSION_HINTS: Record<string, string> = {
  defaultBlurMode: 'off — без фона, blur — размытие, image — виртуальный фон.',
  blurStrength: 'Сила размытия в CSS от 1 до 40.',
  joinWithoutPreview: 'Сразу в комнату, без экрана проверки камеры и микрофона.',
  mirrorSelfView: 'Обычно включено для фронтальной камеры.',
  storeOnServer: 'Если выключить, браузерная запись скачивается на устройство.',
  notifyParticipants: 'При запуске записи в чат отправляется сообщение. Индикатор записи виден всем участникам независимо от этой настройки.',
  format: 'Если браузер не поддерживает запись в MP4, используется WebM.',
  provider: 'Браузерный режим использует доступный браузеру сервис. Серверный режим использует STT на стороне Core.',
  saveTranscript: 'Если выключить, новые субтитры показываются в звонке без добавления в историю и выгрузку.',
  allowedMimeTypes: 'Укажите типы через запятую, например image/*, application/pdf. Пустой список оставляет ограничения сервера.',
  maxFileSizeMb: 'От 1 до 200; на сервере действует дополнительный лимит AGIL_MAX_UPLOAD_MB.',
  preferMotion: 'true — плавность, false — резкость текста.',
};

const SESSION_GROUPS: Record<string, string> = {
  recording: 'Запись',
  transcription: 'Расшифровка',
  fileShare: 'Файлы',
  screenShare: 'Демонстрация экрана',
};

export const sessionSection: SectionDefinition = {
  id: 'session',
  title: 'Сессия',
  icon: 'file',
  description: 'Языки, вход, фон, запись, расшифровка, файлы и показ экрана. Чат — в разделе «Расположение элементов».',
  render(ctx, root) {
    const syncs: Sync[] = [];

    const mainCard = card(tr('Языки и вход'), {
      hint: tr('Значения по умолчанию для новых сессий организации.'),
    });
    const mainFields = renderSchema(sessionSchema, 'session', ctx, {
      labels: SESSION_LABELS,
      hints: SESSION_HINTS,
      groupLabels: SESSION_GROUPS,
      skip: [
        'virtualBackgrounds',
        'recording',
        'transcription',
        'fileShare',
        'screenShare',
        'aiAgent',
        'knowledgeAgent',
        'inCallAgent',
        'chat',
      ],
    });
    mainCard.body.append(mainFields.node);
    root.append(mainCard.root);
    syncs.push(...mainFields.syncs);

    const backgroundsCard = card(tr('Виртуальные фоны'), {
      hint: tr('id — постоянный ключ, name — подпись в интерфейсе, url — картинка (пусто — встроенный градиент).'),
    });
    syncs.push(
      tableField(
        ctx,
        backgroundsCard.body,
        'session.virtualBackgrounds',
        sessionSchema.shape.virtualBackgrounds.element,
        tr('Фоны'),
        {
          labels: SESSION_LABELS,
          idPrefix: 'bg',
          addLabel: 'Добавить фон',
          defaults: { name: tr('Новый фон'), url: '' },
        },
      ),
    );
    root.append(backgroundsCard.root);

    const addGroup = (title: string, schema: Parameters<typeof renderSchema>[0], path: string, options: RenderSchemaOptions = {}): void => {
      const groupCard = card(tr(title));
      const fields = renderSchema(schema, path, ctx, {
        ...options,
        labels: { ...SESSION_LABELS, ...options.labels },
        hints: { ...SESSION_HINTS, ...options.hints },
      });
      groupCard.body.append(fields.node);
      root.append(groupCard.root);
      syncs.push(...fields.syncs);
    };

    addGroup('Запись', sessionSchema.shape.recording, 'session.recording', {
      skip: ['includeChat'],
      labels: { consentRequired: 'Подтверждать начало записи' },
      hints: { consentRequired: 'Тот, кто запускает запись, подтверждает её начало.' },
    });
    addGroup('Расшифровка', sessionSchema.shape.transcription, 'session.transcription', {
      labels: { consentRequired: 'Требовать согласие на расшифровку', nodeId: 'ID узла STT' },
      hints: { nodeId: 'Укажите узел организации для удалённого серверного распознавания. Пустое поле отключает проверку узла.' },
    });
    addGroup('Файлы', sessionSchema.shape.fileShare, 'session.fileShare', { skip: ['storeOnServer'] });
    addGroup('Демонстрация экрана', sessionSchema.shape.screenShare, 'session.screenShare');

    return syncs;
  },
};
