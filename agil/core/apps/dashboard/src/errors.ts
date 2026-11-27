/** Friendly Russian descriptions for API failures (no key material, no stack traces). */
import { ApiError } from './api.js';
import { currentOrigin } from './format.js';

export interface ErrorInfo {
  title: string;
  message: string;
  hint?: string;
  offline: boolean;
  unauthorized: boolean;
}

export interface ErrorContext {
  /** The key came from the «Платформенный ключ» login mode. */
  platform?: boolean;
}

const OFFLINE_HINT =
  'Запустите сервер командой «npm run dev» (порт 8787) или проверьте адрес сервера в настройках.';

const CODE_MESSAGES: Record<string, string> = {
  unauthorized: 'API-ключ неверный или не указан.',
  invalid_token: 'Сессия или токен недействительны — войдите заново или обновите ключ.',
  token_expired: 'Сессия или токен истекли — войдите заново или выпустите новый токен.',
  session_invalid: 'Сессия недействительна — проверьте подключение и войдите заново.',
  forbidden: 'API-ключ выдан для другой организации. Проверьте, что ключ относится к этой организации.',
  not_found: 'Объект не найден на сервере.',
  validation_failed: 'Сервер отклонил данные — проверьте значения полей.',
  tenant_id_retired: 'Этот идентификатор принадлежал удалённой организации. Укажите другой.',
  password_required: 'Комната защищена паролем.',
  password_invalid: 'Неверный пароль комнаты.',
  geo_blocked: 'Вход запрещён гео-политикой организации.',
  room_locked: 'Комната заблокирована.',
  room_full: 'В комнате нет свободных мест.',
  rate_limited: 'Слишком много запросов — подождите немного.',
  node_modules_unavailable: 'Узел сейчас не принимает команды модулей. Проверьте состояние в его карточке.',
  module_autostart_unavailable: 'Агент узла не сообщил доступную политику автозапуска этого модуля.',
  file_too_large: 'Файл превышает допустимый размер.',
  unsupported_mime: 'Тип файла не поддерживается.',
  stt_not_configured: 'Распознавание речи (STT) на сервере не настроено — задайте переменную окружения AGIL_STT_URL.',
  integrity_failed: 'Проверка подлинности медиа не пройдена.',
  internal_error: 'Внутренняя ошибка сервера.',
  invalid_response: 'Сервер вернул неожиданный ответ.',
  http_401: 'Ключ недействителен. Проверьте API-ключ.',
  http_403: 'Доступ запрещён: ключ не подходит для этого режима или организации.',
  http_404: 'Адрес сервиса (endpoint) не найден — возможно, на сервере другая версия.',
  http_500: 'Внутренняя ошибка сервера.',
  http_502: 'Сервер недоступен: ошибка шлюза (bad gateway).',
  http_503: 'Сервер временно недоступен.',
};

export function describeError(error: unknown, context: ErrorContext = {}): ErrorInfo {
  if (error instanceof ApiError) {
    if (error.offline) {
      return {
        title: error.code === 'timeout' ? 'Сервер не отвечает' : 'Сервер недоступен',
        message: error.message,
        hint: OFFLINE_HINT,
        offline: true,
        unauthorized: false,
      };
    }
    if (error.unauthorized) {
      return {
        title: context.platform ? 'Платформенный ключ не принят' : 'Сессия или токен недействительны',
        message: context.platform
          ? 'Сервер не принял платформенный ключ (401). Проверьте, что ключ совпадает с AGIL_PLATFORM_KEY на сервере и что сервер перезапущен после его смены.'
          : CODE_MESSAGES[error.code] ?? 'Сессия или токен недействительны — войдите заново или обновите API-ключ.',
        hint: context.platform
          ? 'Ключ организации вводится без галочки «Платформенный ключ». Код ответа сервера: 401.'
          : 'Проверьте API-ключ в разделе «Настройки → Подключение». На демо-сервере по умолчанию действует ключ «dev-key».',
        offline: false,
        unauthorized: true,
      };
    }
    if (context.platform && error.status === 403) {
      return {
        title: 'Платформенный ключ не принят',
        message:
          'Сервер отклонил платформенный ключ (403). Проверьте, что это ключ AGIL_PLATFORM_KEY платформы, а не ключ организации: ключ организации вводится без галочки «Платформенный ключ».',
        hint: 'Если ключ только что сменили на сервере — перезапустите сервис AgilFrame и повторите вход. Код ответа сервера: 403.',
        offline: false,
        unauthorized: false,
      };
    }
    return {
      title: error.status >= 500 ? 'Ошибка сервера' : 'Запрос отклонён',
      message:
        CODE_MESSAGES[error.code] ??
        CODE_MESSAGES[`http_${error.status}`] ??
        (error.status === 401
          ? 'Ключ недействителен.'
          : error.status === 403
            ? 'Ключ не подходит для этой организации или раздела. Проверьте, что ключ выдан для неё и не является платформенным.'
            : 'Сервер отклонил запрос.'),
      hint:
        error.status === 403
          ? 'Код ответа сервера: 403. Ключ организации вводится без галочки «Платформенный ключ».'
          : error.status > 0
            ? `Код ответа сервера: ${error.status}.`
            : undefined,
      offline: false,
      unauthorized: false,
    };
  }

  if (error instanceof TypeError) {
    return {
      title: 'Сеть недоступна',
      message: 'Браузер не смог выполнить запрос к серверу.',
      hint: `Проверьте, что сервер запущен: ${currentOrigin().replace(/:\d+$/, ':8787')} или адрес в настройках.`,
      offline: true,
      unauthorized: false,
    };
  }

  return {
    title: 'Неожиданная ошибка',
    message: error instanceof Error ? error.message : 'Что-то пошло не так. Попробуйте ещё раз.',
    hint: 'Повторите действие. Если ошибка повторяется — проверьте подключение и API-ключ в настройках.',
    offline: false,
    unauthorized: false,
  };
}

/** One-line error text for toasts. */
export function errorMessage(error: unknown): string {
  const info = describeError(error);
  return info.hint && !info.offline ? `${info.message} ${info.hint}` : `${info.title}: ${info.message}`;
}
