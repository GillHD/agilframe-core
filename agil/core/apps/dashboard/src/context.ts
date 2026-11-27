/** Application context shared by screens and UI components. */
import type { DocContentResponse } from '@agil/protocol';
import type { AdminApi } from './api.js';
import type { StoredCredentials } from './auth.js';
import type { ThemeController } from './theme.js';
import type { ToastKind } from './ui/toast.js';

export type ServerStatus = 'online' | 'offline' | 'checking';

export interface DocumentDraft {
  base: DocContentResponse;
  content: string;
}

export interface AppContext {
  api: AdminApi;
  credentials: StoredCredentials;
  /** Tenant resolved from GET /v1/admin/overview. */
  tenantId: string;
  /** True only for a platform owner key (AGIL_PLATFORM_KEY). */
  platform: boolean;
  setPlatformMode(enabled: boolean): void;
  readonly documentDrafts: Map<string, DocumentDraft>;
  documentDraftsChanged(): void;
  theme: ThemeController;
  navigate(path: string): void;
  toast(message: string, kind?: ToastKind): void;
  setServerStatus(status: ServerStatus, detail?: string): void;
  setPageTitle(title: string, subtitle?: string): void;
  /** Settings screen: re-verify and swap server/key at runtime. */
  saveConnection(input: { serverUrl: string; apiKey: string }): Promise<void>;
  /** Re-renders the current route (used after destructive actions). */
  reload(): void;
  openWikiPlatformLogin(): void;
  logout(): void;
}

export interface ScreenInstance {
  el: HTMLElement;
  destroy?(): void;
}

export type ScreenFactory = (ctx: AppContext, params: Readonly<Record<string, string>>) => ScreenInstance;

export interface RouteDefinition {
  id: string;
  /** Pattern without '#', e.g. '/rooms/:id'. */
  path: string;
  title: string;
  screen: ScreenFactory;
}
