/**
 * Critical-change guard for the dashboard mascot.
 *
 * Compares the live tenant configuration with a proposed change and returns a
 * plain-language risk report: what will change, who is affected, what may break
 * and whether an explicit confirmation is required.
 */
import type { GuardAssessRequest, GuardAssessResponse, GuardFinding, GuardRisk } from '@agil/protocol';

type Json = Record<string, unknown>;
type GuardTranslate = (russian: string, english: string) => string;

const CRITICAL_FEATURES = new Set([
  'chat',
  'chatHistoryOnJoin',
  'fileShare',
  'recording',
  'captions',
  'screenShare',
  'knowledgeAgent',
  'assistant',
  'participantList',
]);
const WARN_FEATURES = new Set(['blur', 'virtualBackgrounds', 'handRaise', 'reactions', 'fullscreen', 'pictureInPicture', 'settings', 'inviteLinks']);

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isRecord(base) || !isRecord(patch)) return (patch === undefined ? base : (patch as T));
  const result: Json = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isRecord(value) && isRecord(result[key])) result[key] = deepMerge(result[key] as Json, value);
    else result[key] = value;
  }
  return result as T;
}

function flatten(value: unknown, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, out);
  } else if (Array.isArray(value)) {
    out.set(prefix, value);
  } else {
    out.set(prefix, value);
  }
  return out;
}

function changedPaths(current: unknown, next: unknown): Array<{ path: string; from: unknown; to: unknown }> {
  const before = flatten(current);
  const after = flatten(next);
  const paths = new Set([...before.keys(), ...after.keys()]);
  const changes: Array<{ path: string; from: unknown; to: unknown }> = [];
  for (const path of paths) {
    const a = before.get(path);
    const b = after.get(path);
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ path, from: a, to: b });
  }
  return changes;
}

function finding(
  id: string,
  severity: GuardFinding['severity'],
  title: string,
  description: string,
  impact: string,
  affected: string[],
  requiresConfirmation: boolean,
): GuardFinding {
  return { id, severity, title, description, impact, affected, requiresConfirmation };
}

function riskFrom(findings: GuardFinding[]): GuardRisk {
  if (findings.some((item) => item.severity === 'critical')) return 'critical';
  if (findings.filter((item) => item.severity === 'warn').length >= 2) return 'high';
  if (findings.some((item) => item.severity === 'warn')) return 'medium';
  return 'low';
}

function featurePath(path: string): string | undefined {
  const match = /^features\.([A-Za-z0-9_]+)$/.exec(path);
  return match?.[1];
}

function assessConfigChanges(
  changes: Array<{ path: string; from: unknown; to: unknown }>,
  context: GuardContext,
  tr: GuardTranslate,
): GuardFinding[] {
  const findings: GuardFinding[] = [];
  const rooms = context.rooms ?? 0;
  const participants = context.participants ?? 0;
  for (const change of changes) {
    const feature = featurePath(change.path);
    if (feature) {
      const disabled = change.from === true && change.to === false;
      const enabled = change.from === false && change.to === true;
      if (disabled) {
        const critical = CRITICAL_FEATURES.has(feature);
        findings.push(
          finding(
            `feature-off:${feature}`,
            critical ? 'critical' : 'warn',
            tr(`Выключается функция «${feature}»`, `Disabling “${feature}”`),
            tr(`Флаг features.${feature} меняется с true на false.`, `The features.${feature} flag changes from true to false.`),
            critical
              ? tr(
                `Функция исчезнет у всех пользователей компании: кнопки/API вернут 403. Активных комнат: ${rooms}, участников: ${participants}.`,
                `The feature becomes unavailable throughout the organization. Feature actions and API requests may return 403. Active rooms: ${rooms}. Participants: ${participants}.`,
              )
              : tr(
                'Функция станет недоступна всем пользователям компании (при необходимости верните флаг).',
                'The feature becomes unavailable throughout the organization. Re-enable the flag to restore it.',
              ),
            [tr('все пользователи тенанта', 'all organization users'), tr(`${rooms} комнат`, `${rooms} active rooms`), tr('API и виджет', 'API and widget')],
            critical,
          ),
        );
      } else if (enabled && /recording|knowledgeAgent|fileShare|captions/i.test(feature)) {
        findings.push(
          finding(
            `feature-on:${feature}`,
            'warn',
            tr(`Включается чувствительная функция «${feature}»`, `Enabling “${feature}”, a feature that handles sensitive data`),
            tr(`Флаг features.${feature} включается для всех.`, `The features.${feature} flag is being enabled for everyone.`),
            tr(
              'Появятся новые данные (записи/файлы/транскрипты/знания): проверьте политику хранения, согласия и доступ ролей.',
              'This can create recordings, files, transcripts, or knowledge data. Check retention, consent and role access.',
            ),
            [tr('администратор', 'administrators'), tr('безопасность', 'security'), tr('юристы', 'legal team')],
            false,
          ),
        );
      }
    }
    if (/^branding\.mascotUrl$/.test(change.path) || /^branding\.logoUrl$/.test(change.path)) {
      findings.push(
        finding(
          `branding:${change.path}`,
          'info',
          tr('Меняется брендинг', 'Branding is changing'),
          tr(`Поле ${change.path} обновляется.`, `The ${change.path} field is changing.`),
          tr(
            'Визуальные изменения у всех новых сессий; кэш может показать старое изображение до обновления.',
            'New sessions will use the new branding. A cached image may remain visible until refresh.',
          ),
          [tr('все пользователи', 'all users')],
          false,
        ),
      );
    }
    if (/^security\.accessPolicy\.customRoles$/.test(change.path)) {
      const before = Array.isArray(change.from) ? change.from.map((role) => (isRecord(role) ? role.id : '')).filter(Boolean) : [];
      const after = Array.isArray(change.to) ? change.to.map((role) => (isRecord(role) ? role.id : '')).filter(Boolean) : [];
      const removed = before.filter((id) => !after.includes(id));
      if (removed.length > 0) {
        findings.push(
          finding(
            'roles-removed',
            'critical',
            tr(`Удаляются роли: ${removed.join(', ')}`, `Removing roles: ${removed.join(', ')}`),
            tr('Из accessPolicy.customRoles удалены определения ролей.', 'Role definitions are being removed from accessPolicy.customRoles.'),
            tr(
              'Новые токены с этими roleId получат 400; активные участники продолжат звонок, но при reconnect применятся baseRole. Проверьте, что роли не используются интеграциями.',
              'New tokens with these role IDs will return 400. Current participants stay in the call and fall back to their base role if they reconnect. Check integrations that use these roles.',
            ),
            [tr('участники с этими ролями', 'participants with these roles'), tr('интеграции/каталог сотрудников', 'integrations and employee directory')],
            true,
          ),
        );
      }
    }
    if (/^security\.accessPolicy\.mode$/.test(change.path) && change.to === 'strict') {
      findings.push(
        finding(
          'access-strict',
          'critical',
          tr('Включается строгий режим доступа', 'Enabling strict access mode'),
          tr(
            'roleDefaults больше не действуют по умолчанию; права выдаются только явно.',
            'roleDefaults no longer grant permissions automatically. Permissions must be granted explicitly.',
          ),
          tr(
            'Большинство пользователей могут потерять доступ к функциям (403), если не настроены overrides/token permissions. Активных комнат: ',
            'Users may lose access to features (403) unless overrides or token permissions are configured. Active rooms: ',
          ) + rooms,
          [tr('все роли', 'all roles'), tr('участники', 'participants')],
          true,
        ),
      );
    }
    if (/^security\.geo\.enabled$/.test(change.path) && change.to === false) {
      findings.push(finding(
        'geo-off',
        'critical',
        tr('Отключается гео-политика', 'Disabling geographic restrictions'),
        tr('Проверка страны/allow-list перестанет работать.', 'The country and country allowlist checks will stop.'),
        tr(
          'Звонки станут доступны из любых стран, включая запрещённые; аудит перестанет фиксировать geo-события.',
          'Calls may accept participants from previously blocked countries. The audit log stops recording geographic-policy events.',
        ),
        [tr('безопасность', 'security'), tr('все комнаты', 'all rooms')],
        true,
      ));
    }
    if (/^security\.geo\.allowedCountries$/.test(change.path)) {
      const after = Array.isArray(change.to) ? change.to : [];
      if (after.length === 0) {
        findings.push(finding(
          'geo-empty',
          'critical',
          tr('Пустой список разрешённых стран', 'The country allowlist is empty'),
          tr('allowedCountries очищен.', 'allowedCountries was cleared.'),
          tr(
            'При включённой гео-политике никто не сможет войти (или политика станет бессмысленной).',
            'Review how an empty allowlist affects joins when geographic restrictions are enabled.',
          ),
          [tr('все участники', 'all participants')],
          true,
        ));
      }
    }
    if (/^integrations\.allowedOrigins$/.test(change.path)) {
      const after = Array.isArray(change.to) ? change.to : [];
      if (after.includes('*') || after.length === 0) {
        findings.push(finding(
          'cors-open',
          'critical',
          tr('CORS открывается для всех', 'Allowing cross-origin API requests from any site'),
          tr('allowedOrigins пуст или содержит * — API можно вызывать с любого сайта.', 'allowedOrigins is empty or contains *.'),
          tr(
            'Ослабление защиты от CSRF/кражи токенов; проверьте, что это действительно нужно.',
            'Broadening CORS access can expose API responses to more sites. Confirm the intended origins.',
          ),
          [tr('безопасность API', 'API security')],
          true,
        ));
      }
    }
    if (/^session\.(fileShare|recording|chat)\.enabled$/.test(change.path) && change.to === false) {
      findings.push(finding(
        `session-off:${change.path}`,
        'warn',
        tr('Отключается сессионная функция', 'Disabling a session feature'),
        tr(`${change.path} выключается.`, `${change.path} is being disabled.`),
        tr(
          'Соответствующие элементы UI/API перестанут работать; ранее выданные signed-ссылки могут остаться валидными до истечения.',
          'Related controls and API actions will stop working. Previously signed links may remain valid until they expire.',
        ),
        [tr('активные пользователи', 'active users')],
        false,
      ));
    }
    if (/^scale\.mediaMode$/.test(change.path) && change.to !== 'mesh') {
      findings.push(
        finding(
          'scale-media-mode',
          'critical',
          tr('Меняется режим медиа', 'Changing the media mode'),
          `mediaMode → ${String(change.to)}.`,
          tr(
            'SFU/broadcast в MVP — контракт/интерфейс; полноценная оркестрация SFU/кластера не реализована. Большие комнаты могут не работать или деградировать. Оставьте mesh, пока не развёрнут SFU.',
            'Configure a working SFU before switching. Large rooms can fail or lose media quality if the required infrastructure is unavailable.',
          ),
          [tr('крупные комнаты', 'large rooms'), tr('вебинары', 'webinars')],
          true,
        ),
      );
    }
    if (/^scale\.maxParticipants$/.test(change.path)) {
      const nextLimit = Number(change.to);
      if (Number.isFinite(nextLimit) && nextLimit > 1000) {
        findings.push(finding(
          'scale-limit',
          'critical',
          tr('Поднимается лимит участников', 'Increasing the participant limit'),
          `maxParticipants → ${nextLimit}.`,
          tr(
            'Без SFU/мульти-ноды и TURN-пула комната не выдержит такую нагрузку: зависания, потеря медиа, отказы. Это изменение лимита, а не мощности.',
            'Confirm sufficient SFU, signaling and TURN capacity. Raising the configured limit alone may result in freezes, media loss and failures.',
          ),
          [tr('крупные комнаты', 'large rooms'), tr('инфраструктура', 'infrastructure')],
          true,
        ));
      }
    }
    if (/^providers\.[A-Za-z0-9_]+\.(mode|endpoint)$/.test(change.path)) {
      const after = String(change.to ?? '');
      if (after === 'external' || /^http:\/\//i.test(after)) {
        findings.push(finding(
          `provider:${change.path}`,
          'critical',
          tr('Меняется внешний провайдер', 'Changing an external provider'),
          `${change.path} → ${after}.`,
          tr(
            'Данные пойдут во внешнюю систему; при http:// — без шифрования. Проверьте SSRF-политику, секреты (только имена env), fallback и договор/DPA.',
            'Data will leave the platform. HTTP sends it without encryption. Review the destination policy, environment variable names, fallback and data processing terms.',
          ),
          [tr('данные пользователей', 'user data'), tr('интеграции', 'integrations')],
          true,
        ));
      }
    }
    if (/^webhooks(\.[A-Za-z0-9_-]+)?\.url$/.test(change.path) && /^http:\/\//i.test(String(change.to ?? ''))) {
      findings.push(finding(
        `webhook:${change.path}`,
        'critical',
        tr('Вебхук без TLS', 'Webhook without TLS'),
        tr('URL вебхука использует http://.', 'The webhook URL uses http://.'),
        tr(
          'События и подписи будут передаваться в открытом виде; возможна утечка метаданных.',
          'Events and signatures will travel unencrypted, which can expose metadata.',
        ),
        [tr('события', 'events'), tr('безопасность', 'security')],
        true,
      ));
    }
    if (/^webhooks\.enabled$/.test(change.path) && change.to === false) {
      findings.push(finding(
        'webhooks-off',
        'warn',
        tr('Отключаются вебхуки', 'Disabling webhooks'),
        tr('Внешние системы перестанут получать события.', 'External systems will stop receiving events.'),
        tr(
          'Интеграции (CRM/HR/SIEM) не узнают о записях, транскриптах, security-событиях.',
          'CRM, HR and SIEM integrations will stop receiving recording, transcript and security events.',
        ),
        [tr('интеграции', 'integrations')],
        false,
      ));
    }
    if (/^docsEnabled$/.test(change.path) || /^integrations\.mcp\.(enabled|public)$/.test(change.path)) {
      if (change.to === true) findings.push(finding(
        'exposure',
        'warn',
        tr('Публикуется API/MCP документация', 'Publishing the API or MCP documentation'),
        tr(`${change.path} включается.`, `${change.path} is being enabled.`),
        tr(
          'openapi/MCP станут доступны снаружи; на проде закройте allowlist/IP-ограничениями.',
          'OpenAPI or MCP will be externally accessible. Restrict production access by IP or allowlist as appropriate.',
        ),
        [tr('безопасность', 'security')],
        false,
      ));
    }
    if (/^security\.turn/.test(change.path)) {
      findings.push(finding(
        `turn:${change.path}`,
        'warn',
        tr('Меняются TURN-настройки', 'Changing TURN settings'),
        tr(`${change.path} обновляется.`, `${change.path} is changing.`),
        tr(
          'При ошибке TURN звонки из корпоративных сетей перестанут проходить (только relay). Проверьте тестом TURN.',
          'An incorrect TURN configuration can block calls from corporate networks that require relaying. Test the TURN connection.',
        ),
        [tr('участники за NAT', 'participants behind NAT')],
        false,
      ));
    }
    if (/^session\.password|^security\.requirePassword/.test(change.path)) {
      findings.push(finding(
        `password:${change.path}`,
        'warn',
        tr('Меняется парольная защита комнат', 'Changing room password protection'),
        `${change.path} → ${String(change.to)}.`,
        tr(
          'Ослабление защиты комнат может пустить посторонних; изменение пароля сломает выданные ссылки.',
          'Weaker password protection can let unauthorized people join. Changing the password can invalidate existing invitations.',
        ),
        [tr('гости', 'guests'), tr('внешние приглашения', 'external invitations')],
        change.path.includes('enabled') && change.to === false,
      ));
    }
  }
  return findings;
}

export interface GuardContext {
  rooms?: number;
  participants?: number;
  tenantName?: string;
}

function configuredUserOverrides(config: unknown): Record<string, unknown> {
  const security = isRecord(config) ? config.security : undefined;
  const policy = isRecord(security) ? security.accessPolicy : undefined;
  return isRecord(policy) && isRecord(policy.userOverrides) ? policy.userOverrides : {};
}

export function assessChange(request: GuardAssessRequest, current: unknown, context: GuardContext = {}): GuardAssessResponse {
  const tr: GuardTranslate = (russian, english) => request.locale === 'en' ? english : russian;
  const merged = deepMerge(current, request.next);
  const changes = changedPaths(current, merged);
  const findings: GuardFinding[] = [];

  if (request.kind === 'config' && request.editorDraft) {
    const nextOverrides = configuredUserOverrides(request.next);
    const removed = Object.keys(configuredUserOverrides(current)).filter((id) => !Object.hasOwn(nextOverrides, id));
    if (removed.length > 0) {
      findings.push(finding(
        'overrides-removed', 'warn', tr('Удаляются персональные права', 'Removing access overrides'),
        tr(`Будут удалены настройки для ${removed.length} пользователей.`, `Access settings will be removed for ${removed.length} users.`),
        tr(
          'После удаления доступ определяется ролью, токеном и политикой организации. Набор разрешённых действий может измениться.',
          'Their role, token and organization policy will determine access. The actions they can use may change.',
        ),
        [tr('пользователи с удалёнными настройками', 'users whose overrides are being removed')], true,
      ));
    }
  }

  if (request.kind === 'roles') {
    const nextRoles = isRecord(request.next) && Array.isArray(request.next.roles) ? request.next.roles : [];
    const currentRoles = isRecord(current) && Array.isArray(current.roles) ? current.roles : [];
    const removed = currentRoles.filter((role) => isRecord(role) && !nextRoles.some((next) => isRecord(next) && next.id === role.id));
    for (const role of removed) {
      if (isRecord(role) && !role.builtin) {
        findings.push(finding(
          `role-delete:${String(role.id)}`,
          'critical',
          tr(`Удаляется роль «${String(role.name ?? role.id)}»`, `Removing the “${String(role.name ?? role.id)}” role`),
          tr('Роль исчезнет из списка и из accessPolicy.customRoles.', 'The role will be removed from the list and from accessPolicy.customRoles.'),
          tr(
            'Новые токены с этой ролью получат 400; активные участники при reconnect потеряют её права (baseRole).',
            'New tokens for this role will return 400. Active participants who reconnect will fall back to their base role.',
          ),
          [tr('участники с ролью', 'participants with this role'), tr('интеграции', 'integrations')],
          true,
        ));
      }
    }
    for (const role of nextRoles) {
      if (!isRecord(role)) continue;
      if (role.builtin === false && role.baseRole === 'host' && role.canModerate === true) {
        findings.push(finding(
          `role-host:${String(role.id)}`,
          'warn',
          tr(`Роль «${String(role.name)}» получает права host`, `Granting host permissions to “${String(role.name)}”`),
          tr('Своя роль с baseRole=host и canModerate.', 'The custom role uses baseRole=host and canModerate.'),
          tr(
            'Участники с ней смогут модерировать/управлять комнатой. Убедитесь, что это минимально необходимо.',
            'People with this role can moderate or manage rooms. Check that these permissions are necessary.',
          ),
          [tr('безопасность', 'security')],
          false,
        ));
      }
    }
  } else if (request.kind === 'access') {
    if (isRecord(request.next) && isRecord(request.next.policy)) {
      findings.push(...assessConfigChanges(changedPaths(current, merged), context, tr));
    }
  } else {
    findings.push(...assessConfigChanges(changes, context, tr));
  }

  if (request.intent && /удал|delete|выключ|disable|сброс|reset/i.test(request.intent) && findings.length === 0) {
    findings.push(finding(
      'intent-destructive',
      'warn',
      tr('Действие выглядит необратимым', 'This action may be irreversible'),
      tr(`Заявленное намерение: «${request.intent}».`, `Stated intent: “${request.intent}”.`),
      tr(
        'Проверьте, можно ли откатить изменение и есть ли резервная копия конфигурации.',
        'Confirm that you can revert the change and have a configuration backup.',
      ),
      [tr('администратор', 'administrators')],
      false,
    ));
  }

  const requiresConfirmation = findings.some((item) => item.requiresConfirmation) || findings.filter((item) => item.severity === 'warn').length >= 2;
  const risk = riskFrom(findings);
  const criticalCount = findings.filter((item) => item.severity === 'critical').length;
  const affected = Array.from(new Set(findings.flatMap((item) => item.affected)));
  const summary =
    findings.length === 0
      ? tr('Изменение выглядит безопасным: критичных последствий не обнаружено.', 'No critical consequences were found.')
      : tr(
        `Обнаружено ${findings.length} последствий${criticalCount ? `, из них критичных: ${criticalCount}` : ''}.`,
        `Findings: ${findings.length}${criticalCount ? `, including ${criticalCount} critical` : ''}.`,
      );
  const message =
    findings.length === 0
      ? tr(
        'Я проверил изменение — всё выглядит безопасно. Можно сохранять, но перед публикацией лучше проверить звонок в тестовой комнате.',
        'Review the change in a test room before publishing it.',
      )
      : tr(
        `Стоп, давайте проверим. ${summary} Затронуто: ${affected.join(', ')}. ${requiresConfirmation ? 'Это может сломать работу пользователей — вы действительно хотите продолжить?' : 'Продолжаем?'}`,
        `${summary} Affected: ${affected.join(', ')}. ${requiresConfirmation ? 'This can disrupt users. Do you want to continue?' : 'Continue?'}`,
      );
  const recommendations = findings.length === 0
    ? [tr('Сохраните резервную копию конфигурации (JSON) перед публикацией.', 'Back up the configuration as JSON before publishing.'), tr('Проверьте изменение в тестовой комнате.', 'Try the change in a test room.')]
    : [
        tr('Сделайте экспорт текущего конфига (JSON) — это позволит откатиться.', 'Export the current configuration as JSON so you can restore it.'),
        tr('Проверьте изменение на тестовой комнате с двумя участниками.', 'Try the change in a test room with two participants.'),
        tr('Предупредите пользователей, если функция будет недоступна.', 'Notify users if a feature will become unavailable.'),
        tr('Если сомневаетесь — оставьте как есть или ограничьте изменение отдельной ролью/комнатой.', 'Consider keeping the current configuration or limiting the change to a specific role or room.'),
      ];

  return { risk, requiresConfirmation, summary, message, findings, recommendations };
}
