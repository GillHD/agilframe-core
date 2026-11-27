/** Russian labels and grouping for every feature flag (access matrix, embed generator). */
import { featureKeys, type FeatureKey } from '@agil/protocol';

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  chat: 'Чат',
  chatHistoryOnJoin: 'История чата при входе',
  fileShare: 'Обмен файлами',
  screenShare: 'Демонстрация экрана',
  handRaise: 'Поднятая рука',
  reactions: 'Реакции',
  participantList: 'Список участников',
  selfView: 'Своё видео',
  gridPinning: 'Закрепление плиток',
  fullscreen: 'Полный экран',
  pictureInPicture: 'Картинка в картинке',
  statsPanel: 'Статистика связи',
  deviceSettings: 'Настройки устройств',
  backgroundBlur: 'Размытие фона',
  backgroundReplace: 'Замена фона',
  noiseSuppression: 'Шумоподавление',
  noiseDetection: 'Предупреждение о шуме',
  lowBandwidthFallback: 'Резервный режим при слабой связи',
  recording: 'Запись звонка',
  captions: 'Субтитры',
  waitingRoom: 'Зал ожидания',
  inviteLink: 'Ссылка-приглашение',
  keyboardShortcuts: 'Горячие клавиши',
  breakoutRooms: 'Отдельные комнаты (breakout)',
  polls: 'Опросы',
  whiteboard: 'Доска',
  annotations: 'Пометки на экране',
  liveStreaming: 'Трансляция',
  sipDialIn: 'Дозвон по SIP',
  calendarIntegration: 'Интеграция с календарём',
  translation: 'Перевод',
  aiAssistant: 'ИИ-ассистент',
  aiCompliance: 'Проверка соответствия правилам (ИИ)',
  knowledgeAgent: 'Ассистент по базе знаний',
  autoFraming: 'Автокадрирование',
  lowLightEnhancement: 'Улучшение при слабом свете',
  speakerSpotlight: 'Фокус на говорящем',
  remoteControl: 'Удалённое управление',
  webinarMode: 'Режим вебинара',
  meetingNotes: 'Заметки встречи',
};

export function featureLabel(key: FeatureKey | string): string {
  return FEATURE_LABELS[key as FeatureKey] ?? key;
}

export interface FeatureGroup {
  id: string;
  title: string;
  keys: FeatureKey[];
}

/** Groups keep the 39-flag matrix readable; every key lands in exactly one group. */
export const FEATURE_GROUPS: readonly FeatureGroup[] = [
  {
    id: 'core',
    title: 'Участие и общение',
    keys: [
      'chat',
      'chatHistoryOnJoin',
      'fileShare',
      'handRaise',
      'reactions',
      'participantList',
      'selfView',
      'inviteLink',
      'keyboardShortcuts',
    ],
  },
  {
    id: 'media',
    title: 'Медиа и связь',
    keys: [
      'screenShare',
      'recording',
      'captions',
      'backgroundBlur',
      'backgroundReplace',
      'noiseSuppression',
      'noiseDetection',
      'lowBandwidthFallback',
      'statsPanel',
      'deviceSettings',
      'fullscreen',
      'pictureInPicture',
      'gridPinning',
      'autoFraming',
      'lowLightEnhancement',
      'speakerSpotlight',
    ],
  },
  {
    id: 'collab',
    title: 'Продвинутая совместная работа',
    keys: [
      'breakoutRooms',
      'polls',
      'whiteboard',
      'annotations',
      'remoteControl',
      'webinarMode',
      'liveStreaming',
      'translation',
      'sipDialIn',
      'calendarIntegration',
      'waitingRoom',
    ],
  },
  {
    id: 'ai',
    title: 'ИИ и знания',
    keys: ['aiAssistant', 'aiCompliance', 'knowledgeAgent', 'meetingNotes'],
  },
];

/** Filters groups to the keys known to the server, appending unknown keys at the end. */
export function groupFeatureKeys(keys: readonly FeatureKey[]): FeatureGroup[] {
  const allowed = new Set(keys);
  const groups: FeatureGroup[] = [];
  const used = new Set<FeatureKey>();
  for (const group of FEATURE_GROUPS) {
    const filtered = group.keys.filter((key) => allowed.has(key));
    if (filtered.length > 0) {
      groups.push({ ...group, keys: filtered });
      for (const key of filtered) used.add(key);
    }
  }
  const leftover = keys.filter((key) => !used.has(key));
  if (leftover.length > 0) groups.push({ id: 'other', title: 'Прочее', keys: leftover });
  return groups;
}

/** All feature keys known to the running protocol build. */
export function allFeatureKeys(): FeatureKey[] {
  return [...featureKeys];
}
