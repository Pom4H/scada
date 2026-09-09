import { compile } from '../source';
import { configurationJSON } from './protocol';
import { isProject, type ProjectSnapshot, type ProjectResponse } from './project';
import type { RuntimeWorkspace } from './workspace';

interface Host { source(): string; replaceSource(text: string): void; toast(message: string): void; initialDraft: boolean }
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
/** Project revisions are authoring input. They never enter the telemetry/undo path as frames. */
export class ProjectWorkspace {
  applying = false;
  private applied: ProjectSnapshot | null = null;
  private incoming: ProjectSnapshot | null = null;
  private openedPath = '';
  private baseline = '';
  private dirty: boolean;
  private writable = false;
  private role = 'view';
  private busy = false;
  private polling = false;
  private epoch = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private message = '';
  private pinned = false;
  constructor(private runtime: RuntimeWorkspace, private host: Host) {
    this.dirty = host.initialDraft;
    $('project-files').onclick = () => { this.fillFiles(); $<HTMLDialogElement>('project-dialog').showModal(); };
    $('project-close').onclick = () => $<HTMLDialogElement>('project-dialog').close();
    $('project-file-list').onchange = () => this.previewFile();
    $('project-open-file').onclick = () => this.action(() => {
      const project = this.incoming ?? this.applied;
      const path = $<HTMLSelectElement>('project-file-list').value;
      if (project?.scenes.includes(path)) { this.apply(project, path); $<HTMLDialogElement>('project-dialog').close(); }
    });
    $('project-apply').onclick = () => this.action(() => { if (this.incoming) this.apply(this.incoming, this.openedPath || this.incoming.entry); });
    $('project-save').onclick = () => { void this.save().catch(error => { this.host.toast(error instanceof Error ? error.message : String(error)); }); };
  }
  private action(task: () => void) { try { task(); } catch (error) { this.host.toast(error instanceof Error ? error.message : String(error)); } }
  changed() {
    if (this.applying) return;
    this.dirty = this.applied ? this.host.source() !== this.baseline : true;
    this.render();
  }
  provenance() {
    if (!this.applied || this.dirty || this.host.source() !== this.baseline || this.runtime.client.config?.project !== this.applied.id) return undefined;
    return { projectRevision: this.applied.revision, projectEntry: this.openedPath };
  }
  async connected(runId?: string) {
    const epoch = ++this.epoch; clearInterval(this.timer); this.incoming = null; this.pinned = !!runId;
    const config = this.runtime.client.config; if (!config) return;
    const session = await this.runtime.client.request<{ role: string }>('/api/session');
    this.runtime.setRole(session.role); this.role = session.role;
    const list = await this.runtime.client.request<{ projects: { id: string }[] }>('/api/projects');
    if (epoch !== this.epoch) return;
    if (!list.projects.length) { this.applied = null; this.baseline = ''; this.openedPath = ''; $('project-sync').hidden = true; return; }
    // A configured server may supply the project ID; a run link always keeps its explicit project.
    if (!runId && !list.projects.some(p => p.id === config.project) && list.projects.length === 1) {
      config.project = list.projects[0].id; $<HTMLInputElement>('server-project').value = config.project;
    }
    const response = runId
      ? await this.runtime.client.request<ProjectResponse>(`/api/runs/${encodeURIComponent(runId)}/project`)
      : await this.runtime.client.request<ProjectResponse>(`/api/projects/${encodeURIComponent(config.project)}`);
    if (epoch !== this.epoch) return;
    this.receive(response, true);
    // Saved runs keep their exact files even when the deployment branch advances.
    if (!runId) this.timer = setInterval(() => { void this.poll(); }, 1500);
    await this.runtime.refreshRuns();
  }
  private async poll() {
    if (this.polling || this.busy || !this.runtime.client.config || this.runtime.status === 'disconnected') return;
    this.polling = true; const epoch = this.epoch;
    try {
      const config = this.runtime.client.config, revision = this.incoming?.revision ?? this.applied?.revision ?? '';
      const response = await this.runtime.client.request<ProjectResponse>(`/api/projects/${encodeURIComponent(config.project)}?knownRevision=${encodeURIComponent(revision)}`);
      if (epoch === this.epoch) this.receive(response);
    } catch { /* Connection changes are handled by the runtime, without discarding a draft. */ }
    finally { this.polling = false; }
  }
  private receive(response: ProjectResponse, first = false) {
    this.writable = response.writable && this.role !== 'view'; this.message = response.error ?? '';
    const project = response.project;
    if (!project) { if (first) { this.applied = null; this.baseline = ''; this.openedPath = ''; } this.render(); return; }
    if (!isProject(project) || project.id !== this.runtime.client.config?.project) throw new Error('Некорректные файлы проекта.');
    if (project.revision === this.applied?.revision) { this.render(); return; }
    this.incoming = project;
    const next = project.files.find(f => f.path === (this.openedPath || project.entry));
    let compatible = false;
    try { compatible = !!next && configurationJSON(compile(next.content).scene) === configurationJSON(compile(this.host.source()).scene); } catch { /* A draft may be temporarily incomplete. */ }
    if (!this.dirty && (!this.runtime.runId || compatible) && (!first || !this.host.initialDraft)) this.apply(project, this.openedPath || project.entry);
    else this.render();
  }
  private preserveDraft() {
    if (!this.dirty && !this.host.source().trim()) return;
    // Retain only source, not the client/configuration object containing connection state.
    try {
      const key = 'scada.project.drafts.v1';
      const drafts: unknown[] = JSON.parse(localStorage.getItem(key) ?? '[]');
      const list = Array.isArray(drafts) ? drafts.slice(-9) : [];
      list.push({ project: this.applied?.id ?? 'local', revision: this.applied?.revision, path: this.openedPath || 'scene.ts', source: this.host.source(), savedAt: Date.now() });
      localStorage.setItem(key, JSON.stringify(list));
    } catch { throw new Error('Не удалось сохранить черновик. Скачайте .ts перед заменой проекта.'); }
  }
  private apply(project: ProjectSnapshot, path: string) {
    if (!project.scenes.includes(path)) path = project.entry;
    const openingScene = !this.applied || this.applied.id !== project.id || this.openedPath !== path;
    const source = project.files.find(f => f.path === path)!.content; compile(source);
    if (this.dirty) this.preserveDraft();
    this.applying = true;
    try { this.host.replaceSource(source); } finally { this.applying = false; }
    this.applied = project; this.incoming = null; this.openedPath = path; this.baseline = source; this.dirty = false;
    // Use the existing active-view command; ordinary revision updates keep the user's camera.
    if (openingScene) $<HTMLButtonElement>('fit').click();
    this.message = ''; this.render(); this.host.toast(`Открыт ${path} · Git ${project.revision.slice(0, 8)}`);
  }
  private async save() {
    const project = this.applied;
    if (!project || this.busy || !this.writable || this.pinned || !this.dirty) return;
    const source = this.host.source(); compile(source);
    if (this.incoming && this.incoming.revision !== project.revision) throw new Error('На сервере новая ревизия. Сохраните черновик и загрузите её перед новым коммитом.');
    this.busy = true; this.render(); const epoch = this.epoch;
    try {
      const response = await this.runtime.client.request<ProjectResponse>(`/api/projects/${encodeURIComponent(project.id)}`, { baseRevision: project.revision, path: this.openedPath, content: source, message: $<HTMLInputElement>('project-commit-message').value || `Update ${this.openedPath}` });
      if (epoch !== this.epoch) return;
      if (!response.project || !isProject(response.project)) throw new Error('Некорректный ответ Git.');
      this.applied = response.project; this.baseline = source; this.dirty = this.host.source() !== source; this.incoming = null;
      this.host.toast(`Коммит ${response.project.revision.slice(0, 8)} сохранён; проект обновлён.`);
    } finally { this.busy = false; this.render(); }
  }
  private render() {
    const project = this.incoming ?? this.applied;
    $('project-sync').hidden = !project;
    if (!project) return;
    $('project-revision').textContent = `${project.id} · ${this.applied?.revision.slice(0, 8) ?? 'не открыт'}${this.pinned ? ' · версия прогона' : ''}`;
    $('project-status').textContent = this.message || (this.incoming ? `Новая ревизия ${this.incoming.revision.slice(0, 8)}. ${this.dirty ? 'Локальный черновик сохранится при загрузке.' : 'Текущий прогон использует свою конфигурацию.'}` : this.dirty ? 'Локальный черновик' : 'Файлы синхронизированы с Git');
    $('project-apply').hidden = !this.incoming;
    $<HTMLButtonElement>('project-save').disabled = !this.writable || this.pinned || !this.dirty || this.busy || !!this.incoming || this.runtime.status !== 'connected';
  }
  private fillFiles() {
    const project = this.incoming ?? this.applied; if (!project) return;
    const select = $<HTMLSelectElement>('project-file-list'); select.replaceChildren();
    for (const file of project.files) { const option = document.createElement('option'); option.value = file.path; option.textContent = file.path; select.append(option); }
    select.value = project.files.some(f => f.path === this.openedPath) ? this.openedPath : project.entry; this.previewFile();
  }
  private previewFile() {
    const project = this.incoming ?? this.applied, path = $<HTMLSelectElement>('project-file-list').value;
    $<HTMLTextAreaElement>('project-file-preview').value = project?.files.find(f => f.path === path)?.content ?? '';
    $<HTMLButtonElement>('project-open-file').disabled = !project?.scenes.includes(path);
  }
  dispose() { this.epoch++; clearInterval(this.timer); }
}
