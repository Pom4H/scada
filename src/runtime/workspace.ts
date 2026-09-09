import { catalog } from '../core';
import { compile, setRuntimeConfiguration, type Compiled } from '../source';
import { RuntimeClient, offlineFrame, validateDestination, isFrame } from './client';
import { configurationJSON, numeric, type RunSummary, type RuntimeConfig, type RuntimeFrame, type TrendSelection, type TrendSeries, type TrendPoint } from './protocol';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const button = (id: string) => $<HTMLButtonElement>(id);
const choose = (id: string) => $<HTMLSelectElement>(id);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} с`;
const option = (value: string, label: string) => { const e = document.createElement('option'); e.value = value; e.textContent = label; return e; };
const svgEl = (tag: string, attrs: Record<string, string | number>) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };
interface Host {
  source(): string;
  compiled(): Compiled | null;
  selected(): string | null;
  replaceSource(source: string): void;
  display(frame: RuntimeFrame | null): void;
  toast(message: string): void;
  connected?(runId?: string): Promise<void>;
  provenance?(): { projectRevision: string; projectEntry: string } | undefined;
}
/** Runtime state has no reference to CodeMirror transactions or local storage. */
export class RuntimeWorkspace {
  readonly client = new RuntimeClient();
  frame: RuntimeFrame | null = null;
  private displayed: RuntimeFrame | null = null;
  private runs: RunSummary[] = [];
  private currentRun: RunSummary | null = null;
  private matchingConfiguration = '';
  private authoredConfiguration = '';
  private authoredRuntime = '';
  private history: RuntimeFrame[] = [];
  private comparison: RuntimeFrame[] = [];
  private liveHistory: RuntimeFrame[] = [];
  private events = new Map<string, RuntimeFrame['events'][number]>();
  private replaying = false;
  private playback: ReturnType<typeof setTimeout> | undefined;
  private operation = 0;
  private commandSignature = '';
  private message = '';
  private sourceValid = true;
  private role = 'operator';
  setRole(role: string) { this.role = role; this.updateControls(); }
  private historyLimit: { seq: number; simTimeMs: number } | null = null;
  private overview: TrendSeries | null = null;
  private comparisonOverview: TrendSeries | null = null;
  private compareId = '';
  private trendRequest = 0;
  private historyRequest = 0;
  private graphKey = '';
  private playGeneration = 0;
  private playing = false;
  private rangeStart = 0;
  private rangeEnd = 0;
  private trendChoiceKey = '';
  constructor(private host: Host) {
    this.client.onStatus = (status, message) => {
      this.message = message;
      if (status !== 'connected' && this.frame && !this.replaying) this.display(offlineFrame(this.frame, status === 'stale' ? 'stale' : 'offline'));
      this.updateControls();
    };
    this.client.onFrame = frame => {
      this.frame = frame;
      if (this.status === 'connected') {
        if (frame.type === 'snapshot' && this.liveHistory.length && frame.seq > this.liveHistory.at(-1)!.seq + 1) this.liveHistory.push(offlineFrame({ ...frame, simTimeMs: frame.simTimeMs - 1 }));
        if (frame.seq > (this.liveHistory.at(-1)?.seq ?? -1)) this.liveHistory.push(frame);
        while (this.liveHistory[0]?.simTimeMs < frame.simTimeMs - 60_000) this.liveHistory.shift();
      }
      if (this.currentRun && frame.runStatus) this.currentRun.status = frame.runStatus;
      else if (frame.events.some(e => e.type === 'run.completed') && this.currentRun) this.currentRun.status = 'completed';
      if (this.status === 'stale' || this.status === 'reconnecting') {
        if (this.liveHistory.at(-1)?.seq !== frame.seq || this.liveHistory.at(-1) !== frame) this.liveHistory.push(frame);
      }
      while (this.liveHistory.length > 1000) this.liveHistory.shift();
      this.collectEvents(frame);
      if (!this.replaying) { this.display(frame); this.drawTrend(this.liveHistory); }
      this.updateControls();
    };
    button('connect-server').onclick = () => this.action(async () => {
      if (this.client.config) this.disconnect();
      else await this.connect(this.formConfiguration(), input('server-token').value);
    });
    input('server-token').addEventListener('keydown', event => { if (event.key === 'Enter') button('connect-server').click(); });
    for (const id of ['server-address', 'server-project']) input(id).addEventListener('change', () => {
      if (this.client.config) this.disconnect();
      $('runtime-destination').textContent = `Назначение: ${input('server-address').value} · ${input('server-project').value}`;
    });
    button('save-runtime').onclick = () => this.action(async () => {
      this.host.replaceSource(setRuntimeConfiguration(this.host.source(), this.formConfiguration()));
      this.host.toast('Адрес и выбранный прогон записаны в TS.');
    });
    button('create-run').onclick = () => this.action(() => this.createRun(choose('scenario-kind').value as 'normal' | 'degradation'));
    button('complete-run').onclick = () => this.action(async () => {
      if (!this.runId) return;
      const result = await this.client.complete(this.runId);
      this.currentRun = result.run; await this.refreshRuns(); this.updateControls();
    });
    button('refresh-runs').onclick = () => this.action(() => this.refreshRuns());
    choose('run-select').onchange = () => { if (choose('run-select').value) this.action(() => this.selectRun(choose('run-select').value)); };
    button('history-load').onclick = () => this.action(async () => {
      this.historyLimit = null; await this.loadHistory(); if (this.history.length) await this.replay(this.history[0].seq);
    });
    choose('trend-signal').onchange = () => { this.graphKey = ''; this.action(async () => { if (this.replaying) await this.loadOverview(); this.drawTrend(this.replaying ? this.history : this.liveHistory, this.comparison); if (this.displayed) this.display(this.displayed); }); };
    for (const [id, direction] of [['history-prev', -1], ['history-next', 1]] as const) button(id).onclick = () => this.action(async () => {
      this.stopPlayback(); input('history-from').value = String(Math.max(0, Number(input('history-from').value) + direction * this.windowMs() / 1000));
      await this.loadHistory(); if (this.history.length) await this.replay(this.history[0].seq);
    });
    button('replay-play').onclick = () => this.action(async () => { if (this.playing) this.stopPlayback(); else { if (!this.history.length) await this.loadHistory(); this.play(); } });
    button('replay-live').onclick = () => this.live();
    input('replay-position').oninput = () => { this.stopPlayback(); const f = this.history[Number(input('replay-position').value)]; if (f) { this.replaying = true; this.display(f); this.drawTrend(this.history, this.comparison); this.updateControls(); } };
    button('compare-history').onclick = () => this.action(async () => {
      const id = choose('compare-run').value; if (!id) throw new Error('Выберите второй прогон.');
      if (!this.history.length) await this.loadHistory();
      this.compareId = id; this.comparison = []; await this.loadOverview(); this.replaying = true;
      if (!this.displayed || this.displayed.runId !== this.runId) this.display(this.history[0]);
      this.drawTrend(this.history, this.comparison); this.updateControls();
    });
    button('service-equipment').onclick = () => this.action(() => this.command(this.target()!, 'service'));
    button('replace-equipment').onclick = () => this.action(() => this.command(this.target()!, 'replace'));
    this.updateControls();
  }
  get active() { return !!this.client.config || !!this.currentRun; }
  get displayedFrame() { return this.displayed; }
  get status() { return this.client.status; }
  get runId() { return this.currentRun?.id ?? null; }
  get mode() { return this.replaying ? 'replay' : this.active ? 'live' : 'preview'; }
  private action(task: () => Promise<unknown>) { void task().catch(error => this.host.toast(error instanceof Error ? error.message : String(error))); }
  private formConfiguration(): RuntimeConfig {
    return validateDestination({ server: input('server-address').value, project: input('server-project').value, ...(this.runId ? { run: this.runId } : this.host.compiled()?.runtime?.run ? { run: this.host.compiled()!.runtime!.run } : {}) });
  }
  sourceChanged(compiled: Compiled | null, preserveConnection = false) {
    this.sourceValid = !!compiled;
    if (!compiled) { this.message = 'Ошибка TS: показана последняя корректная схема; команды заблокированы.'; this.updateControls(); return; }
    this.message = '';
    const canonical = configurationJSON(compiled.scene), runtime = JSON.stringify(compiled.runtime ?? null);
    if (this.matchingConfiguration && canonical !== this.matchingConfiguration) { ++this.operation; this.client.unsubscribe(); this.clearRun(); this.message = 'Параметры модели изменены. Создайте новый прогон; соединение с сервером сохранено.'; }
    if (!preserveConnection && this.authoredRuntime && runtime !== this.authoredRuntime && this.client.config && compiled.runtime && (compiled.runtime.server !== this.client.config.server || compiled.runtime.project !== this.client.config.project || (compiled.runtime.run && compiled.runtime.run !== this.runId))) { this.disconnect('Назначение изменено в TS. Подключитесь явно.'); this.clearRun(); }
    if (!preserveConnection && runtime !== this.authoredRuntime && compiled.runtime) {
      input('server-address').value = compiled.runtime.server; input('server-project').value = compiled.runtime.project;
    }
    this.authoredConfiguration = canonical; this.authoredRuntime = runtime; this.commandSignature = '';
    $('runtime-destination').textContent = `Назначение: ${input('server-address').value} · ${input('server-project').value}${compiled.runtime?.run ? ` · ${compiled.runtime.run}` : ''}`;
    this.updateControls();
  }
  async connect(config: RuntimeConfig, token: string) {
    const operation = ++this.operation;
    this.clearRun(); input('server-address').value = config.server; input('server-project').value = config.project;
    this.runs = await this.client.connect(config, token); input('server-token').value = '';
    if (operation !== this.operation) return;
    await this.host.connected?.(config.run);
    if (operation !== this.operation) return;
    this.populateRuns();
    if (config.run) await this.selectRun(config.run);
    this.updateControls();
  }
  disconnect(message = '') {
    ++this.operation; this.client.disconnect(); this.stopPlayback();
    if (this.frame) this.display(offlineFrame(this.frame));
    this.message = message; this.updateControls();
  }
  private clearRun() {
    this.stopPlayback(); this.currentRun = null; this.matchingConfiguration = ''; this.frame = null; this.displayed = null; this.history = []; this.comparison = []; this.liveHistory = []; this.events.clear(); this.replaying = false; this.historyLimit = null; this.overview = null; this.comparisonOverview = null; this.compareId = ''; this.graphKey = ''; this.trendRequest++; this.historyRequest++;
    this.host.display(null); $('runtime-events').replaceChildren(); $('runtime-metrics').replaceChildren(); this.drawTrend([]);
  }
  private async hash() {
    const compiled = compile(this.host.source());
    const canonical = configurationJSON(compiled.scene);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    return { canonical, hash: [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('') };
  }
  async selectRun(id: string) {
    const operation = ++this.operation;
    const [{ run, snapshot }, identity] = await Promise.all([this.client.run(id), this.hash()]);
    if (operation !== this.operation) return;
    if (run.projectId !== this.client.config!.project || run.sourceHash !== identity.hash) {
      this.disconnect(); throw new Error('Этот прогон относится к другой конфигурации. Откройте его исходную ссылку.');
    }
    if (configurationJSON(compile(this.host.source()).scene) !== identity.canonical) throw new Error('Схема изменилась во время запроса. Повторите выбор прогона.');
    this.clearRun(); this.currentRun = run; this.matchingConfiguration = identity.canonical;
    this.client.subscribe(run.id, snapshot, run.status); this.populateRuns(); this.updateControls();
  }
  async refreshRuns() { this.runs = await this.client.runs(); this.populateRuns(); }
  async createRun(scenario: 'normal' | 'degradation') {
    if (this.role === 'view') throw new Error('Для создания прогона нужны права оператора.');
    if (!this.client.config) throw new Error('Подключитесь к серверу.');
    const operation = ++this.operation, text = this.host.source(), identity = await this.hash();
    const { run, snapshot } = await this.client.create({ projectId: this.client.config.project, source: text, scenario, seed: 42, label: `Прогон ${this.runs.length + 1}`, ...this.host.provenance?.() });
    if (operation !== this.operation) return;
    if (configurationJSON(compile(this.host.source()).scene) !== identity.canonical) throw new Error('Схема изменилась во время запроса. Повторите выбор прогона.');
    this.clearRun(); this.currentRun = run; this.matchingConfiguration = identity.canonical; this.runs.unshift(run);
    this.client.subscribe(run.id, snapshot, run.status); this.populateRuns(); this.updateControls();
    return run;
  }
  async command(equipmentId: string, command: string, value?: number | string | boolean) {
    if (this.role === 'view' || !this.sourceValid || this.currentRun?.status !== 'running' || this.replaying || this.status !== 'connected' || !this.runId) throw new Error('Команды доступны только в подключённом живом прогоне.');
    return this.client.command(this.runId, { commandId: crypto.randomUUID(), equipmentId, command, ...(value === undefined ? {} : { value }) });
  }
  private windowMs() {
    const duration = Number(input('history-window').value);
    if (!Number.isFinite(duration) || duration < 1 || duration > 300) throw new Error('Окно истории: от 1 до 300 секунд.');
    return Math.round(duration * 1000);
  }
  private async readHistory(id: string, fromMs: number, after = -1) {
    const operation = this.operation, request = this.historyRequest, frames: RuntimeFrame[] = [];
    const detail = await this.client.run(id);
    if (operation !== this.operation || request !== this.historyRequest || id !== this.runId) return [];
    if (!this.historyLimit) this.historyLimit = { seq: detail.snapshot.seq, simTimeMs: detail.snapshot.simTimeMs };
    const limit = this.historyLimit;
    this.rangeStart = fromMs; this.rangeEnd = Math.min(limit.simTimeMs, fromMs + this.windowMs());
    if (fromMs > limit.simTimeMs) return [];
    const range = { fromMs, toMs: this.rangeEnd, untilSeq: limit.seq };
    let previous = after;
    while (true) {
      const page = await this.client.history(id, after, range);
      if (operation !== this.operation || request !== this.historyRequest || id !== this.runId) return [];
      if (!Array.isArray(page.frames) || !Number.isSafeInteger(page.nextAfter) || typeof page.hasMore !== 'boolean' || page.frames.length > 500) throw new Error('Некорректная страница истории.');
      for (const frame of page.frames) {
        if (!isFrame(frame) || frame.runId !== id || (previous >= 0 && frame.seq !== previous + 1) || frame.seq > limit.seq || frame.simTimeMs < range.fromMs || frame.simTimeMs > range.toMs) throw new Error('Нарушен порядок или диапазон кадров истории.');
        frames.push(frame); previous = frame.seq;
      }
      if (frames.length > 10_000) throw new Error('Слишком много команд в окне. Выберите более короткий диапазон.');
      if (!page.hasMore) break;
      if (page.nextAfter <= after || page.nextAfter !== previous) throw new Error('История не продвигается.');
      after = page.nextAfter;
    }
    return frames;
  }
  private async loadOverview() {
    const id = this.runId, request = ++this.trendRequest; if (!id) return;
    const selection = this.trendSelection(); if (!selection.equipmentId && !selection.linkId) return;
    const detail = await this.client.run(id), limit = this.historyLimit ?? detail.snapshot;
    const overview = await this.client.trend(id, selection, { fromMs: 0, toMs: limit.simTimeMs, untilSeq: limit.seq });
    let comparison: TrendSeries | null = null;
    if (this.compareId) {
      const other = await this.client.run(this.compareId);
      if (other.run.sourceHash !== detail.run.sourceHash || other.run.projectId !== detail.run.projectId) throw new Error('Сравнение требует одинаковой конфигурации оборудования.');
      comparison = await this.client.trend(this.compareId, selection, { fromMs: 0, toMs: other.snapshot.simTimeMs, untilSeq: other.snapshot.seq });
    }
    if (request !== this.trendRequest || id !== this.runId) return;
    this.overview = overview; this.comparisonOverview = comparison; this.graphKey = '';
  }
  async loadHistory(fromMs = Math.round(Number(input('history-from').value) * 1000), after = -1) {
    const id = this.runId; if (!id) throw new Error('Выберите прогон.');
    if (!Number.isSafeInteger(fromMs) || fromMs < 0) throw new Error('Начало истории должно быть неотрицательным.');
    const request = ++this.historyRequest;
    const frames = await this.readHistory(id, fromMs, after); if (id !== this.runId || request !== this.historyRequest) return [];
    this.history = frames; for (const frame of frames) this.collectEvents(frame, false); this.renderEvents();
    input('history-from').value = String(fromMs / 1000);
    input('replay-position').max = String(Math.max(0, frames.length - 1));
    if (!this.overview) await this.loadOverview();
    this.graphKey = ''; this.updateControls(); return frames;
  }
  async replay(seq: number) {
    if (!this.runId) throw new Error('Выберите прогон.');
    this.stopPlayback(); const id = this.runId;
    const frame = this.history.find(f => f.seq === seq) ?? await this.client.replay(id, seq);
    if (id !== this.runId) return;
    if (!isFrame(frame) || frame.runId !== id || frame.seq !== seq) throw new Error('Некорректный кадр записи.');
    this.replaying = true; this.display(frame); this.drawTrend(this.history.length ? this.history : [frame], this.comparison); this.updateControls(); return frame;
  }
  live() { this.stopPlayback(); this.replaying = false; this.comparison = []; this.comparisonOverview = null; this.compareId = ''; this.graphKey = ''; if (this.frame) this.display(this.status === 'connected' ? this.frame : offlineFrame(this.frame)); this.drawTrend(this.liveHistory); this.updateControls(); }
  private stopPlayback() { this.playGeneration++; this.playing = false; clearTimeout(this.playback); this.playback = undefined; button('replay-play').textContent = 'Воспроизвести'; }
  private play() {
    if (!this.history.length) return;
    this.stopPlayback(); const generation = this.playGeneration;
    let index = this.replaying ? this.history.findIndex(f => f.seq === this.displayed?.seq) : -1;
    if (index >= this.history.length - 1 && this.history.at(-1)!.seq >= (this.historyLimit?.seq ?? 0)) index = -1;
    this.replaying = true; this.playing = true; button('replay-play').textContent = 'Пауза записи';
    this.drawTrend(this.history, this.comparison);
    const tick = async () => {
      if (generation !== this.playGeneration) return;
      let frame = this.history[++index];
      if (!frame) {
        const last = this.history.at(-1);
        if (!last || last.seq >= (this.historyLimit?.seq ?? 0)) { this.stopPlayback(); this.updateControls(); return; }
        await this.loadHistory(last.simTimeMs, last.seq);
        if (generation !== this.playGeneration) return;
        index = 0; frame = this.history[0];
        if (!frame) { this.stopPlayback(); this.updateControls(); return; }
      }
      this.display(frame); this.updateControls();
      const next = this.history[index + 1];
      this.playback = setTimeout(() => { void tick().catch(error => { this.stopPlayback(); this.host.toast(String(error)); }); }, Math.max(0, next ? next.simTimeMs - frame.simTimeMs : 100));
    }; void tick().catch(error => { this.stopPlayback(); this.host.toast(String(error)); });
  }
  shareSource() { return this.client.config ? setRuntimeConfiguration(this.host.source(), { ...this.client.config, ...(this.runId ? { run: this.runId } : {}) }) : this.host.source(); }
  private populateRuns() {
    choose('run-select').replaceChildren(option('', 'Выберите прогон'), ...this.runs.map(r => option(r.id, `${r.label} · ${r.id.slice(0, 8)}`)));
    choose('run-select').value = this.runId ?? '';
    const previous = choose('compare-run').value;
    choose('compare-run').replaceChildren(option('', 'Сравнить с…'), ...this.runs.filter(r => r.id !== this.runId).map(r => option(r.id, r.label)));
    choose('compare-run').value = previous;
  }
  private target() { const nodes = this.host.compiled()?.scene.nodes ?? []; return nodes.find(n => n.id === this.host.selected())?.id ?? nodes.find(n => Object.keys(catalog[n.kind].commands ?? {}).length)?.id ?? null; }
  selectionChanged() {
    this.commandSignature = ''; this.trendChoiceKey = ''; this.graphKey = ''; this.updateControls();
    if (this.displayed) this.display(this.displayed);
    this.action(async () => { if (this.replaying) await this.loadOverview(); this.drawTrend(this.replaying ? this.history : this.liveHistory, this.comparison); });
  }
  private trendSelection(): TrendSelection {
    const selected = this.host.selected();
    if (selected && this.host.compiled()?.scene.links.some(link => link.id === selected)) return { linkId: selected, signal: 'flow' };
    return { equipmentId: this.target() ?? undefined, signal: choose('trend-signal').value || 'flow' };
  }
  private updateTrendChoices() {
    const selected = this.host.selected(), node = this.host.compiled()?.scene.nodes.find(n => n.id === this.target());
    const isLink = selected && this.host.compiled()?.scene.links.some(l => l.id === selected);
    const key = `${isLink ? selected : node?.id}:${node?.kind}`;
    if (key === this.trendChoiceKey) return;
    this.trendChoiceKey = key;
    const fields = isLink ? { flow: { label: 'Расход', type: 'number', unit: 'm3/h' } } : node ? catalog[node.kind].signals ?? {} : {};
    const available = Object.entries(fields).filter(([, s]) => s.type === 'number');
    choose('trend-signal').replaceChildren(...available.map(([name, s]) => option(name, `${s.label} · ${s.unit}`)));
    choose('trend-signal').value = available.some(([name]) => name === 'flow') ? 'flow' : available[0]?.[0] ?? '';
  }
  private updateControls() {
    this.updateTrendChoices();
    const connected = this.status === 'connected', selected = !!this.currentRun;
    const labels = { disconnected: this.active ? 'Связь отключена' : 'Локальный предпросмотр', connecting: 'Подключение…', connected: 'Подключено', stale: 'Данные устарели', reconnecting: 'Связь потеряна · восстановление…', error: 'Ошибка подключения' };
    $('connection-status').textContent = `${labels[this.status]}${this.message ? ` · ${this.message}` : ''}`; $('connection-status').dataset.status = this.status;
    button('connect-server').textContent = this.client.config ? 'Отключиться' : 'Подключиться';
    for (const id of ['create-run', 'refresh-runs']) button(id).disabled = !connected || (id === 'create-run' && (!this.sourceValid || this.role === 'view'));
    choose('run-select').disabled = !connected; choose('compare-run').disabled = !connected || !selected;
    for (const id of ['history-load', 'compare-history']) button(id).disabled = !connected || !selected;
    button('history-prev').disabled = !connected || !selected || this.rangeStart <= 0;
    button('history-next').disabled = !connected || !selected || !this.historyLimit || this.rangeEnd >= this.historyLimit.simTimeMs;
    button('replay-play').disabled = !this.history.length; input('replay-position').disabled = !this.history.length;
    button('replay-live').disabled = !selected || !this.replaying;
    $('run-label').textContent = this.currentRun ? `${this.currentRun.label}${this.currentRun.projectRevision ? ' · Git ' + this.currentRun.projectRevision.slice(0, 8) : ''} · ${this.replaying ? 'запись' : this.currentRun.status === 'completed' ? 'завершён' : this.currentRun.status === 'failed' ? 'ошибка модели' : 'эфир'} · синтетика` : 'Синтетические данные';
    const target = this.target(), node = this.host.compiled()?.scene.nodes.find(n => n.id === target), commands = node ? catalog[node.kind].commands ?? {} : {};
    const disabled = this.role === 'view' || !this.sourceValid || !connected || !selected || this.replaying || this.currentRun?.status !== 'running';
    button('complete-run').disabled = disabled;
    $('command-target').textContent = target ?? 'Выберите оборудование';
    button('service-equipment').hidden = !commands.service; button('replace-equipment').hidden = !commands.replace;
    button('service-equipment').disabled = disabled; button('replace-equipment').disabled = disabled;
    const signature = `${target}:${Object.keys(commands)}:${disabled}`;
    if (signature !== this.commandSignature) {
      this.commandSignature = signature; const root = $('equipment-commands'); root.replaceChildren();
      for (const [name, definition] of Object.entries(commands)) {
        if (name === 'service' || name === 'replace') continue;
        let value: HTMLInputElement | HTMLSelectElement | undefined;
        if (definition.valueType) {
          if (definition.choices) { value = document.createElement('select'); for (const c of definition.choices) value.append(option(c, c)); }
          else { value = document.createElement('input'); value.type = definition.valueType === 'number' ? 'number' : definition.valueType === 'boolean' ? 'checkbox' : 'text'; if (definition.min !== undefined) value.min = String(definition.min); if (definition.max !== undefined) value.max = String(definition.max); value.value = definition.valueType === 'number' ? String(Math.max(definition.min ?? 0, Math.min(definition.max ?? 1500, 1500))) : ''; }
          value.setAttribute('aria-label', definition.label); value.disabled = disabled; root.append(value);
        }
        const b = document.createElement('button'); b.textContent = definition.label; b.disabled = disabled;
        b.onclick = () => this.action(() => this.command(target!, name, value ? definition.valueType === 'number' ? Number(value.value) : definition.valueType === 'boolean' ? (value as HTMLInputElement).checked : value.value : undefined)); root.append(b);
      }
    }
  }
  private display(frame: RuntimeFrame | null) {
    this.displayed = frame; this.host.display(frame); if (!frame) return;
    const target = this.target(), equipment = target ? frame.equipment[target] : undefined;
    $('runtime-metrics').replaceChildren();
    if (equipment) {
      const modes: Record<string, string> = { running: 'Работает', starting: 'Запускается', stopped: 'Остановлен', maintenance: 'Обслуживание', available: 'Готов', empty: 'Пуст', moving: 'Перемещается', ready: 'Готов', unknown: 'Состояние неизвестно', measuring: 'Измеряет', filtering: 'Фильтрует' };
      const alarms = { none: 'Без аварий', warning: 'Предупреждение', trip: 'Авария' };
      const qualities = { stale: 'устарело', bad: 'недостоверно', offline: 'нет связи', good: '' };
      const units: Record<string, string> = { 'm3/h': 'м³/ч', rpm: 'об/мин', 'mm/s': 'мм/с', bar: 'бар' };
      const definition = this.host.compiled()?.scene.nodes.find(node => node.id === target);
      const fact = document.createElement('span'); fact.className = 'equipment-fact'; fact.dataset.alarm = equipment.facts.alarm;
      const unavailable = Object.values(equipment.signals).length > 0 && Object.values(equipment.signals).every(signal => signal.quality !== 'good');
      fact.textContent = unavailable ? `Нет актуальных данных · Экземпляр ${equipment.instanceId}` : `${modes[equipment.facts.mode] ?? equipment.facts.mode} · ${alarms[equipment.facts.alarm]} · Экземпляр ${equipment.instanceId}`; $('runtime-metrics').append(fact);
      for (const [name, signal] of Object.entries(equipment.signals)) {
        const field = document.createElement('span'); field.className = 'signal-value'; field.dataset.signal = name; field.dataset.quality = signal.quality;
        const value = signal.quality !== 'good' || signal.value === null ? '—' : typeof signal.value === 'number' ? signal.value.toFixed(signal.unit === 'rpm' ? 0 : 2) : typeof signal.value === 'boolean' ? signal.value ? 'Да' : 'Нет' : String(signal.value);
        const label = definition ? catalog[definition.kind].signals?.[name]?.label ?? name : name;
        field.textContent = `${label}: ${value} ${units[signal.unit] ?? signal.unit}${signal.quality !== 'good' ? ` · ${qualities[signal.quality]}` : ''}`; $('runtime-metrics').append(field);
      }
    }
    $('replay-time').textContent = `${seconds(frame.simTimeMs)} · #${frame.seq}`;
    input('replay-position').value = String(Math.max(0, this.history.findIndex(f => f.seq === frame.seq)));
    const q = this.flow(frame), selection = this.trendSelection();
    $('flow-readout').textContent = q === null ? '—' : q.toFixed(1);
    $('flow-label').textContent = `${selection.equipmentId ?? selection.linkId ?? '—'} · ${selection.signal} · ${this.replaying ? 'запись' : 'сервер'}`;
    $('flow-unit').textContent = this.signal(frame)?.unit ?? '';
    const cursor = document.getElementById('trend-cursor');
    if (cursor && this.replaying && this.overview) {
      const end = Math.max(this.overview.toMs, this.comparisonOverview?.toMs ?? 0, 1), x = frame.simTimeMs / end * 400;
      cursor.setAttribute('x1', String(x)); cursor.setAttribute('x2', String(x));
    }
  }
  private signal(frame: RuntimeFrame) { const s = this.trendSelection(); return s.linkId ? frame.flows[s.linkId] : s.equipmentId ? frame.equipment[s.equipmentId]?.signals[s.signal] : undefined; }
  private flow(frame: RuntimeFrame) { return numeric(this.signal(frame)); }
  private collectEvents(frame: RuntimeFrame, render = true) { let changed = false; for (const event of frame.events) if (!this.events.has(event.id)) { this.events.set(event.id, event); changed = true; } if (render && changed) this.renderEvents(); }
  private renderEvents() {
    $('event-count').textContent = String(this.events.size);
    const events = [...this.events.values()].sort((a, b) => b.seq - a.seq).slice(0, 100);
    $('runtime-events').replaceChildren(...events.map(e => { const li = document.createElement('li'); li.textContent = `${seconds(e.simTimeMs)} · ${e.equipmentId ?? 'Установка'} · ${e.message}`; return li; }));
  }
  private drawTrend(primary: RuntimeFrame[], secondary: RuntimeFrame[] = []) {
    const selection = this.trendSelection();
    const key = this.replaying && this.overview
      ? `record:${JSON.stringify(selection)}:${this.overview.toMs}:${this.overview.points.at(-1)?.seq}:${this.compareId}:${this.comparisonOverview?.toMs}`
      : `live:${JSON.stringify(selection)}:${primary.at(-1)?.seq}:${primary.length}:${secondary.at(-1)?.seq}`;
    if (key === this.graphKey) return; this.graphKey = key;
    const points = (frames: RuntimeFrame[]): TrendPoint[] => frames.map(f => ({ seq: f.seq, simTimeMs: f.simTimeMs, value: this.flow(f) }));
    const a = this.replaying && this.overview ? this.overview.points : points(primary);
    const b = this.replaying && this.comparisonOverview ? this.comparisonOverview.points : points(secondary);
    const svg = document.getElementById('trend')!; svg.replaceChildren();
    for (const y of [8, 28, 48]) svg.append(svgEl('line', { x1: 0, y1: y, x2: 400, y2: y, stroke: '#dce5e9' }));
    const end = Math.max(this.replaying ? this.overview?.toMs ?? 0 : 0, this.replaying ? this.comparisonOverview?.toMs ?? 0 : 0, a.at(-1)?.simTimeMs ?? 0, b.at(-1)?.simTimeMs ?? 0, 1000), start = this.replaying ? 0 : Math.max(0, end - 60_000);
    const scale = [...a, ...b].reduce((max, p) => Math.max(max, Math.abs(p.value ?? 0)), 1);
    const path = (frames: TrendPoint[], color: string) => {
      let d = '', gap = true;
      for (const point of frames) {
        if (point.simTimeMs < start) continue;
        if (point.value === null) { gap = true; continue; }
        d += `${gap ? 'M' : 'L'}${((point.simTimeMs - start) / Math.max(1, end - start) * 400).toFixed(1)} ${(28 - point.value / scale * 23).toFixed(1)}`; gap = false;
      }
      svg.append(svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.8, 'vector-effect': 'non-scaling-stroke' }));
    };
    path(a, '#218da4'); if (b.length) path(b, '#b87935');
    if (this.replaying) svg.append(svgEl('line', { id: 'trend-cursor', x1: 0, x2: 0, y1: 0, y2: 56, stroke: '#657b88' }));
    const unit = this.replaying ? this.overview?.unit : primary.at(-1) ? this.signal(primary.at(-1)!)?.unit : '';
    $('trend-label').textContent = `${selection.equipmentId ?? selection.linkId ?? '—'} · ${selection.signal}${b.length ? ' · текущий / сравнение' : this.replaying ? ' · запись' : ' · эфир'}`;
    svg.setAttribute('aria-label', $('trend-label').textContent);
    $('trend-scale').textContent = `${seconds(end - start)} · ±${scale.toFixed(1)} ${unit ?? ''}`;
  }
  dispose() { this.client.disconnect(); this.stopPlayback(); }
}
