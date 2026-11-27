/**
 * Feature flag metadata shared by the Features section and the access-policy
 * editor (which lists every flag per role).
 */
import type { FeatureKey } from '@agil/protocol';
import type { BadgeTone } from '../dom';
import { localize } from '../i18n';

export const FEATURE_LABELS: Record<FeatureKey, string> = localize({
  chat: 'Чат',
  chatHistoryOnJoin: 'История чата при входе',
  fileShare: 'Отправка файлов',
  screenShare: 'Демонстрация экрана',
  handRaise: 'Поднятая рука',
  reactions: 'Реакции',
  participantList: 'Список участников',
  selfView: 'Своё видео (self-view)',
  gridPinning: 'Закрепление плиток',
  fullscreen: 'Полный экран',
  pictureInPicture: 'Картинка в картинке',
  statsPanel: 'Панель статистики',
  deviceSettings: 'Настройки устройств',
  backgroundBlur: 'Размытие фона',
  backgroundReplace: 'Замена фона',
  noiseSuppression: 'Подавление шума',
  noiseDetection: 'Предупреждение о шуме',
  lowBandwidthFallback: 'Резервный режим при слабой связи',
  recording: 'Запись звонка',
  captions: 'Субтитры',
  waitingRoom: 'Зал ожидания',
  inviteLink: 'Ссылка-приглашение',
  keyboardShortcuts: 'Горячие клавиши',
  breakoutRooms: 'Отдельные комнаты для групп (breakout)',
  polls: 'Опросы',
  whiteboard: 'Доска для рисования',
  annotations: 'Пометки на экране',
  liveStreaming: 'Трансляция',
  sipDialIn: 'Дозвон по SIP',
  calendarIntegration: 'Интеграция с календарём',
  translation: 'Перевод речи',
  aiAssistant: 'ИИ-ассистент',
  aiCompliance: 'Проверка соответствия с ИИ',
  knowledgeAgent: 'Ассистент по базе знаний',
  autoFraming: 'Автоматическое кадрирование',
  lowLightEnhancement: 'Улучшение при слабом свете',
  speakerSpotlight: 'Режим «Говорящий»',
  remoteControl: 'Удалённое управление',
  webinarMode: 'Режим вебинара',
  meetingNotes: 'Заметки встречи',
});

/** Competitor-parity flags that are declared in the contract but not in MVP UI. */
export const ROADMAP_FLAGS: ReadonlySet<FeatureKey> = new Set<FeatureKey>([
  'calendarIntegration',
  'aiAssistant',
  'autoFraming',
  'lowLightEnhancement',
  'speakerSpotlight',
  'remoteControl',
  'webinarMode',
]);

/** Implemented paths that depend on a configured provider. */
const SERVICE_FLAGS: ReadonlySet<FeatureKey> = new Set(['liveStreaming', 'sipDialIn', 'translation']);

/** MVP flags whose contract may still change. */
export const BETA_FLAGS: ReadonlySet<FeatureKey> = new Set<FeatureKey>(['aiCompliance', 'meetingNotes']);

export const ALL_FEATURES = Object.keys(FEATURE_LABELS) as FeatureKey[];
export const CORE_FEATURES = ALL_FEATURES.filter((flag) => !ROADMAP_FLAGS.has(flag) && !SERVICE_FLAGS.has(flag));
export const SERVICE_FEATURES = ALL_FEATURES.filter((flag) => SERVICE_FLAGS.has(flag));
export const ROADMAP_FEATURES = ALL_FEATURES.filter((flag) => ROADMAP_FLAGS.has(flag));

export function flagBadge(flag: FeatureKey): BadgeTone | undefined {
  if (ROADMAP_FLAGS.has(flag)) return 'roadmap';
  if (BETA_FLAGS.has(flag)) return 'beta';
  return undefined;
}
