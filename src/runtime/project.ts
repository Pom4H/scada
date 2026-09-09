/** The only files a Git project may publish are its manifest's explicit allowlist. */
export interface ProjectFile { path: string; content: string; sha: string }
export interface ProjectSnapshot {
  id: string;
  revision: string;
  entry: string;
  scenes: string[];
  files: ProjectFile[];
}
export interface ProjectResponse { project: ProjectSnapshot | null; writable: boolean; unchanged?: boolean; error?: string; rejectedRevision?: string }
export interface ProjectSave { baseRevision: string; path: string; content: string; message: string }
export const MAX_PROJECT_BYTES = 1_000_000;
export function projectPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 160 && /^[\p{L}\p{N}_-][\p{L}\p{N}_./ -]*\.(ts|json|md|txt|svg)$/u.test(value) &&
    value.split('/').every(part => !!part && part !== '..' && !part.startsWith('.') && !/^(secrets?|credentials?)(\.|$)/i.test(part));
}
export function isProject(value: unknown): value is ProjectSnapshot {
  if (!value || typeof value !== 'object') return false;
  const p = value as ProjectSnapshot;
  if (typeof p.id !== 'string' || !/^[\p{L}\p{N}_.-]{1,64}$/u.test(p.id) || typeof p.revision !== 'string' || !/^[a-f0-9]{40,64}$/.test(p.revision) || !projectPath(p.entry)) return false;
  if (!Array.isArray(p.files) || !p.files.length || p.files.length > 64 || !Array.isArray(p.scenes) || !p.scenes.includes(p.entry)) return false;
  let bytes = 0; const paths = new Set<string>();
  for (const file of p.files) {
    if (!file || !projectPath(file.path) || paths.has(file.path) || typeof file.content !== 'string' || typeof file.sha !== 'string' || !/^[a-f0-9]{40,64}$/.test(file.sha)) return false;
    paths.add(file.path); bytes += new TextEncoder().encode(file.content).length;
    if (file.content.includes('\0') || bytes > MAX_PROJECT_BYTES) return false;
  }
  return p.scenes.every(path => typeof path === 'string' && path.endsWith('.ts') && paths.has(path)) && new Set(p.scenes).size === p.scenes.length;
}
