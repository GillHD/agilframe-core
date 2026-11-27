import { brandSection } from './brand';
import { themeSection } from './theme';
import { featuresSection } from './features';
import { accessSection } from './access';
import { layoutSection } from './layout';
import { mediaSection } from './media';
import { fallbackSection } from './fallback';
import { securitySection } from './security';
import { sessionSection } from './session';
import { aiSection } from './ai';
import { knowledgeSection } from './knowledge';
import { integrationsSection } from './integrations';
import { ssoSection } from './sso';
import { providersSection } from './providers';
import { scalingSection } from './scaling';
import { inCallAssistantSection } from './in-call';
import { roomSection } from './room';
import { tr } from '../i18n';
import type { SectionDefinition } from './types';

export type { SectionDefinition, SectionId } from './types';

/** Order of the left-hand navigation (contract §10, §18, §19). */
const BASE_SECTIONS: readonly SectionDefinition[] = [
  brandSection,
  themeSection,
  featuresSection,
  accessSection,
  layoutSection,
  mediaSection,
  fallbackSection,
  securitySection,
  sessionSection,
  aiSection,
  knowledgeSection,
  integrationsSection,
  ssoSection,
  providersSection,
  scalingSection,
  inCallAssistantSection,
  roomSection,
];

/**
 * The section title/description feed both the left-hand navigation and the
 * section heading, so localizing them here translates the whole outline
 * without touching all 17 section modules (see `src/i18n.ts`).
 */
export const sections: readonly SectionDefinition[] = BASE_SECTIONS.map((section) => ({
  ...section,
  title: tr(section.title),
  description: tr(section.description),
}));
