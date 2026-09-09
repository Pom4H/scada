import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, devNull } from 'node:os';
import { join, resolve } from 'node:path';
import { compile } from '../src/source';
import { isProject, projectPath, MAX_PROJECT_BYTES, type ProjectResponse, type ProjectSnapshot, type ProjectSave } from '../src/runtime/project';

export interface GitProjectOptions {
  repository: string;
  ref?: string;
  manifest?: string;
  pollMs?: number;
  writable?: boolean;
  /** Optional, administrator-configured remote/branch. Never accepted from an HTTP client. */
  remote?: string;
  branch?: string;
}
export class ProjectError extends Error { constructor(message: string, public status = 400) { super(message); } }
const oid = (value: string) => /^[a-f0-9]{40,64}$/.test(value);
const text = (bytes: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
/** Git object reads, one validated in-memory snapshot, one durable last-good ref. No checkout/pull/hooks/eval. */
export class GitProject {
  private current: ProjectSnapshot | null = null;
  private rejectedRevision: string | undefined;
  private error: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inflight: Promise<void> | undefined;
  private closed = false;
  private saving = false;
  private readonly ref: string;
  private readonly manifest: string;
  private readonly activeRef: string;
  constructor(private options: GitProjectOptions, private validateSource: (source: string) => void = source => { compile(source); }) {
    this.ref = options.ref ?? 'HEAD'; this.manifest = options.manifest ?? 'scada.project.json';
    if (!(this.ref === 'HEAD' || /^refs\/(heads|tags|remotes)\/[A-Za-z0-9_./-]+$/.test(this.ref)) || this.ref.includes('..') || this.ref.endsWith('/')) throw new ProjectError('Use HEAD or a fully qualified Git ref');
    if (!projectPath(this.manifest) || !this.manifest.endsWith('.json')) throw new ProjectError('Invalid project manifest path');
    if (options.remote && (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(options.remote) || !options.branch || !/^[A-Za-z0-9][A-Za-z0-9_/-]*$/.test(options.branch))) throw new ProjectError('Invalid configured remote/branch');
    if (options.remote && (this.ref !== `refs/remotes/${options.remote}/${options.branch}` || options.writable)) throw new ProjectError('Remote tracking projects are read-only; ref must match the configured remote/branch');
    if (options.pollMs !== undefined && (!Number.isInteger(options.pollMs) || options.pollMs < 100 || options.pollMs > 3_600_000)) throw new ProjectError('Project polling interval must be 100..3600000 ms');
    // Distinct configured refs/manifests can safely share one repository.
    this.activeRef = `refs/scada/active/${Buffer.from(`${this.ref}:${this.manifest}`).toString('hex')}`;
  }
  private git(args: string[], input?: string, extraEnv: Record<string, string> = {}): Promise<Buffer> {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    return new Promise((accept, reject) => {
      const child = spawn('git', ['-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', '-C', resolve(this.options.repository), ...args], {
        shell: false, windowsHide: true, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const output: Buffer[] = []; let size = 0, failed = false;
      const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); reject(new ProjectError('Git operation timed out', 503)); }, 15_000);
      child.stdout.on('data', (data: Buffer) => { size += data.length; if (size > 2_000_000) { failed = true; child.kill('SIGKILL'); reject(new ProjectError('Git object exceeds project limits')); } else output.push(data); });
      // Drain stderr without exposing repository URLs, local paths or credential-helper output.
      child.stderr.resume(); child.stdin.on('error', () => {});
      child.on('error', () => { clearTimeout(timer); if (!failed) reject(new ProjectError('Git is unavailable', 503)); });
      child.on('close', code => { clearTimeout(timer); if (failed) return; if (code !== 0) reject(new ProjectError('Git operation failed; check the configured repository and ref', 409)); else accept(Buffer.concat(output)); });
      child.stdin.end(input);
    });
  }
  private async resolveRef(ref: string) {
    const sha = text(await this.git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
    if (!oid(sha)) throw new ProjectError('Invalid Git object ID'); return sha;
  }
  private async read(sha: string): Promise<ProjectSnapshot> {
    if (!oid(sha)) throw new ProjectError('Invalid revision');
    const entries = new Map<string, { mode: string; sha: string; size: number }>();
    for (const line of text(await this.git(['ls-tree', '-r', '-l', '-z', sha])).split('\0')) {
      if (!line) continue;
      const match = /^(\d+) (\w+) ([a-f0-9]+)\s+([\d-]+)\t(.*)$/s.exec(line);
      if (match) entries.set(match[5], { mode: match[1], sha: match[3], size: Number(match[4]) });
    }
    const blob = async (path: string) => {
      const item = entries.get(path);
      if (!item || item.mode !== '100644' || !Number.isFinite(item.size) || item.size > 256_000) throw new ProjectError('Published files must be bounded regular UTF-8 files, not symlinks, submodules or executables');
      const content = text(await this.git(['cat-file', 'blob', item.sha]));
      if (content.includes('\0')) throw new ProjectError('Binary project files are not supported');
      return { path, content, sha: item.sha };
    };
    const raw = JSON.parse((await blob(this.manifest)).content);
    if (!raw || raw.version !== 1 || typeof raw.id !== 'string' || !Array.isArray(raw.files) || !raw.files.length || raw.files.length > 64 || Object.keys(raw).some(k => !['version', 'id', 'entry', 'files', 'scenes'].includes(k))) throw new ProjectError('Invalid scada.project.json');
    if (!raw.files.every(projectPath) || new Set(raw.files).size !== raw.files.length || !raw.files.includes(raw.entry)) throw new ProjectError('Invalid project file allowlist');
    let total = 0; const files = [];
    for (const path of raw.files as string[]) {
      total += entries.get(path)?.size ?? MAX_PROJECT_BYTES + 1;
      if (total > MAX_PROJECT_BYTES) throw new ProjectError('Project is too large');
      files.push(await blob(path));
    }
    const project: ProjectSnapshot = { id: raw.id, revision: sha, entry: raw.entry, scenes: raw.scenes ?? [raw.entry], files };
    if (!isProject(project)) throw new ProjectError('Invalid project snapshot');
    for (const path of project.scenes) { try { this.validateSource(files.find(file => file.path === path)!.content); } catch { throw new ProjectError(`Scene validation failed: ${path}`); } }
    return project;
  }
  async start() {
    await this.reload();
    if (!this.current) {
      // An invalid deployment must not make the previous validated release disappear after restart.
      try { this.current = await this.read(await this.resolveRef(this.activeRef)); } catch { throw new ProjectError('No valid project revision is available; validate the manifest and scene first', 503); }
    }
    this.timer = setInterval(() => { void this.reload(); }, this.options.pollMs ?? 1000); this.timer.unref();
    return this;
  }
  reload(): Promise<void> {
    if (this.closed || this.saving) return Promise.resolve();
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => { this.inflight = undefined; }); return this.inflight;
  }
  private async refresh() {
    let revision: string | undefined;
    try {
      if (this.options.remote) await this.git(['fetch', '--no-tags', '--no-recurse-submodules', this.options.remote, `+refs/heads/${this.options.branch}:${this.ref}`]);
      revision = await this.resolveRef(this.ref);
      if (revision === this.current?.revision) { this.error = undefined; this.rejectedRevision = undefined; return; }
      if (revision === this.rejectedRevision) return;
      const candidate = await this.read(revision);
      if (this.current && candidate.id !== this.current.id) throw new ProjectError('Changing project identity requires an explicit server restart');
      await this.git(['update-ref', this.activeRef, revision]);
      this.current = candidate; this.error = undefined; this.rejectedRevision = undefined;
    } catch {
      this.rejectedRevision = revision;
      this.error = 'Новая Git-ревизия не прошла проверку. Продолжает действовать последняя корректная версия.';
    }
  }
  list() { return this.current ? [{ id: this.current.id, revision: this.current.revision, entry: this.current.entry }] : []; }
  get(id: string): ProjectResponse {
    return { project: this.current?.id === id ? structuredClone(this.current) : null, writable: !!this.options.writable, ...(this.error ? { error: this.error, rejectedRevision: this.rejectedRevision } : {}) };
  }
  async save(id: string, value: ProjectSave): Promise<ProjectResponse> {
    if (!this.options.writable) throw new ProjectError('Project is read-only', 403);
    if (!value || !oid(value.baseRevision) || !projectPath(value.path) || typeof value.content !== 'string' || Buffer.byteLength(value.content) > 256_000 || value.content.includes('\0') || typeof value.message !== 'string' || !value.message.trim() || value.message.length > 200 || Object.keys(value).some(k => !['baseRevision', 'path', 'content', 'message'].includes(k))) throw new ProjectError('Invalid project save');
    await this.reload();
    if (this.saving) throw new ProjectError('Another project save is in progress', 409);
    this.saving = true;
    try { return await this.commit(id, value); } finally { this.saving = false; }
  }
  private async commit(id: string, value: ProjectSave): Promise<ProjectResponse> {
    const current = this.current;
    if (!current || current.id !== id) throw new ProjectError('Project not found', 404);
    if (value.baseRevision !== current.revision || await this.resolveRef(this.ref) !== value.baseRevision) throw new ProjectError('Git revision changed. Keep your draft and reload the server version before saving.', 409);
    if (!current.files.some(file => file.path === value.path)) throw new ProjectError('File is outside the published allowlist', 403);
    const ref = this.ref === 'HEAD' ? text(await this.git(['symbolic-ref', '-q', 'HEAD'])).trim() : this.ref;
    if (!ref.startsWith('refs/heads/')) throw new ProjectError('Writing requires a local branch, not a tag or detached HEAD', 409);
    const directory = await mkdtemp(join(tmpdir(), 'scada-git-index-'));
    try {
      const env = { GIT_INDEX_FILE: join(directory, 'index') };
      const blob = text(await this.git(['hash-object', '-w', '--stdin'], value.content)).trim();
      await this.git(['read-tree', value.baseRevision], undefined, env);
      await this.git(['update-index', '--add', '--cacheinfo', `100644,${blob},${value.path}`], undefined, env);
      const tree = text(await this.git(['write-tree'], undefined, env)).trim();
      const revision = text(await this.git(['-c', 'user.name=SCADA operator', '-c', 'user.email=scada@localhost', 'commit-tree', tree, '-p', value.baseRevision], value.message + '\n')).trim();
      const candidate = await this.read(revision); // All scenes must validate before moving the deployment ref.
      await this.git(['update-ref', ref, revision, value.baseRevision]); // Compare-and-swap: concurrent drafts never overwrite each other.
      await this.git(['update-ref', this.activeRef, revision]);
      this.current = candidate; this.error = undefined; this.rejectedRevision = undefined;
      return this.get(id);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  async close() { this.closed = true; clearInterval(this.timer); await this.inflight; }
}
