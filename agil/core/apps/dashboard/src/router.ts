/** Dependency-free hash router: #/overview, #/rooms, #/rooms/:id, ... */
import type { RouteDefinition, ScreenFactory } from './context.js';

export interface RouteMatch {
  route: RouteDefinition;
  params: Record<string, string>;
  path: string;
}

/** '#/rooms/abc?x=1' → '/rooms/abc'. Empty hash maps to the overview. */
export function parsePath(hash: string): string {
  let raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const queryIndex = raw.indexOf('?');
  if (queryIndex >= 0) raw = raw.slice(0, queryIndex);
  if (!raw.startsWith('/')) raw = `/${raw}`;
  raw = raw.replace(/\/{2,}/g, '/');
  if (raw === '/' || raw === '') return '/overview';
  return raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
}

/** Matches '/rooms/:id' style patterns. */
export function matchRoute(routes: RouteDefinition[], path: string): RouteMatch | null {
  const segments = path.split('/').filter(Boolean);
  for (const route of routes) {
    const pattern = route.path.split('/').filter(Boolean);
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < pattern.length; index += 1) {
      const expected = pattern[index] ?? '';
      const actual = segments[index] ?? '';
      if (expected.startsWith(':')) {
        if (!actual) {
          matched = false;
          break;
        }
        try {
          params[expected.slice(1)] = decodeURIComponent(actual);
        } catch {
          matched = false;
          break;
        }
      } else if (expected !== actual) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params, path };
  }
  return null;
}

export class HashRouter {
  private readonly routes: RouteDefinition[];
  private readonly onChange: (match: RouteMatch | null) => void;
  private readonly onHashChange = (): void => this.handleChange();
  private started = false;

  constructor(routes: RouteDefinition[], onChange: (match: RouteMatch | null) => void) {
    this.routes = routes;
    this.onChange = onChange;
  }

  start(initialPath?: string): void {
    if (this.started) return;
    this.started = true;
    window.addEventListener('hashchange', this.onHashChange);
    if (initialPath !== undefined || !window.location.hash || window.location.hash === '#' || window.location.hash === '#/') {
      this.replace(initialPath ?? this.routes[0]?.path ?? '/overview');
      return;
    }
    this.handleChange();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    window.removeEventListener('hashchange', this.onHashChange);
  }

  navigate(path: string): void {
    const target = `#${path.startsWith('/') ? path : `/${path}`}`;
    if (window.location.hash === target) {
      this.handleChange();
      return;
    }
    window.location.hash = target;
  }

  replace(path: string): void {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    const url = `${window.location.pathname}${window.location.search}#${normalized}`;
    window.history.replaceState(null, '', url);
    this.handleChange();
  }

  currentPath(): string {
    return parsePath(window.location.hash);
  }

  private handleChange(): void {
    if (!this.started) return;
    const path = parsePath(window.location.hash);
    this.onChange(matchRoute(this.routes, path));
  }
}

export type { ScreenFactory };
