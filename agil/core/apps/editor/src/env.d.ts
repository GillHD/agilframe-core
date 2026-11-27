/**
 * Editor-specific Vite env keys.
 *
 * `vite/client` already declares `ImportMetaEnv` with an index signature, so we
 * only narrow the keys the editor actually reads.
 */
interface ImportMetaEnv {
  /**
   * Optional preview iframe URL. When unset, the editor picks the default by
   * environment: `http://localhost:5173/embed.html` on localhost/127.0.0.1,
   * otherwise same-origin `<location.origin>/embed.html` (the AGIL server serves
   * the demo at the origin root; the editor itself is mounted under `/editor/`).
   */
  readonly VITE_PREVIEW_URL?: string;
  /**
   * Optional room id used by the preview iframe. The editor always appends
   * `?room=<this>&tenant=<current tenant>` because embed.html refuses to mount
   * without a room; defaults to `preview`.
   */
  readonly VITE_PREVIEW_ROOM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
