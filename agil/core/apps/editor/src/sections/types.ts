import type { IconName } from '../dom';
import type { FieldCtx, Sync } from '../fields';

export type SectionId =
  | 'brand'
  | 'theme'
  | 'features'
  | 'access'
  | 'layout'
  | 'media'
  | 'fallback'
  | 'security'
  | 'session'
  | 'ai'
  | 'knowledge'
  | 'integrations'
  | 'sso'
  | 'providers'
  | 'scaling'
  | 'assistant'
  | 'room';

export interface SectionDefinition {
  id: SectionId;
  title: string;
  icon: IconName;
  description: string;
  /** Renders the section and returns DOM→config sync functions. */
  render(ctx: FieldCtx, container: HTMLElement): Sync[];
}
