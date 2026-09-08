import { catalog } from '../core';
import { compile, setRuntimeConfiguration, type Compiled } from '../source';
import { RuntimeClient, offlineFrame, validateDestination, isFrame } from './client';
import { configurationJSON, numeric, type RunSummary, type RuntimeConfig, type RuntimeFrame } from './protocol';

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
  constructor(private host: Host) {
    this.client.onStatus = (status, message) => {
      this.message = message;
      if (status !== 'connected' && this.frame && !this.replaying) this.display(offlineFrame(this.frame));
      this.updateControls();
    };
    this.client.onFrame = frame => {
      this.frame = frame;
      if (!Object.values(frame.flows).some(s => s.quality === 'offline')) {
        if (frame.type === 'snapshot' && this.liveHistory.length && frame.seq > this.liveHistory.at(-1)!.seq + 1) this.liveHistory.push(offlineFrame({ ...frame, simTimeMs: frame.simTimeMs - 1 }));
        if (frame.seq > (this.liveHistory.at(-1)?.seq ?? -1)) this.liveHistory.push(frame);
        while (this.liveHistory[0]?.simTimeMs < frame.simTimeMs - 60_000) this.liveHistory.shift();
      }
      if (frame.events.some(e => e.type === 'run.completed') && this.currentRun) this.currentRun.status = 'completed';
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
    button('history-load').onclick = () => this.action(async () => { await this.loadHistory(); await this.replay(this.history[0]?.seq ?? 0); });
    button('replay-play').onclick = () => this.action(async () => { if (this.playback) this.stopPlayback(); else { if (!this.history.length) await this.loadHistory(); this.play(); } });
    button('replay-live').onclick = () => this.live();
    input('replay-position').oninput = () => { this.stopPlayback(); const f = this.history[Number(input('replay-position').value)]; if (f) { this.replaying = true; this.display(f); this.drawTrend(this.history, this.comparison); this.updateControls(); } };
    button('compare-history').onclick = () => this.action(async () => {
      const id = choose('compare-run').value; if (!id) throw new Error('Выберите второй прогон.');
      if (!this.history.length) await this.loadHistory();
      this.comparison = await this.readHistory(id); this.replaying = true;
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
  sourceChanged(compiled: Compiled | null) {
    if (!compiled) { if (this.active) this.disconnect('Ошибка TS: соединение остановлено.'); return; }
    const canonical = configurationJSON(compiled.scene), runtime = JSON.stringify(compiled.runtime ?? null);
    if (this.matchingConfiguration && canonical !== this.matchingConfiguration) { this.disconnect('Конфигурация изменена. Создайте новый прогон или откройте исходную схему.'); this.clearRun(); }
    if (this.authoredRuntime && runtime !== this.authoredRuntime && this.client.config && compiled.runtime && (compiled.runtime.server !== this.client.config.server || compiled.runtime.project !== this.client.config.project || (compiled.runtime.run && compiled.runtime.run !== this.runId))) { this.disconnect('Назначение изменено в TS. Подключитесь явно.'); this.clearRun(); }
    if (runtime !== this.authoredRuntime && compiled.runtime) {
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
    this.stopPlayback(); this.currentRun = null; this.matchingConfiguration = ''; this.frame = null; this.displayed = null; this.history = []; this.comparison = []; this.liveHistory = []; this.events.clear(); this.replaying = false;
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
    this.client.subscribe(run.id, snapshot); this.populateRuns(); this.updateControls();
  }
  async refreshRuns() { this.runs = await this.client.runs(); this.populateRuns(); }
  async createRun(scenario: 'normal' | 'degradation') {
    if (!this.client.config) throw new Error('Подключитесь к серверу.');
    const operation = ++this.operation, text = this.host.source(), identity = await this.hash();
    const { run, snapshot } = await this.client.create({ projectId: this.client.config.project, source: text, scenario, seed: 42, label: `Прогон ${this.runs.length + 1}` });
    if (operation !== this.operation) return;
    if (configurationJSON(compile(this.host.source()).scene) !== identity.canonical) throw new Error('Схема изменилась во время запроса. Повторите выбор прогона.');
    this.clearRun(); this.currentRun = run; this.matchingConfiguration = identity.canonical; this.runs.unshift(run);
    this.client.subscribe(run.id, snapshot); this.populateRuns(); this.updateControls();
    return run;
  }
  async command(equipmentId: string, command: string, value?: number | string | boolean) {
    if (this.replaying || this.status !== 'connected' || !this.runId) throw new Error('Команды доступны только в подключённом живом прогоне.');
    return this.client.command(this.runId, { commandId: crypto.randomUUID(), equipmentId, command, ...(value === undefined ? {} : { value }) });
  }
  private async readHistory(id: string) {
    const frames: RuntimeFrame[] = []; let after = -1;
    // Limit to a fixed first-page watermark so a running scenario cannot keep pagination alive forever.
    const detail = await this.client.run(id);
    const identity = await this.hash();
    if (detail.run.projectId !== this.client.config!.project || detail.run.sourceHash !== identity.hash || !isFrame(detail.snapshot) || detail.snapshot.runId !== id) throw new Error('История другой конфигурации или некорректный снимок.');
    const limit = detail.snapshot.seq;
    while (after < limit) {
      const page = await this.client.history(id, after);
      if (!Array.isArray(page.frames) || !Number.isSafeInteger(page.nextAfter) || typeof page.hasMore !== 'boolean') throw new Error('Некорректная страница истории.');
      for (const frame of page.frames) {
        if (!isFrame(frame) || frame.runId !== id || frame.seq !== (frames.at(-1)?.seq ?? -1) + 1) throw new Error('Нарушен порядок или ID кадров истории.');
        if (frame.seq <= limit) frames.push(frame); else break;
      }
      if (!page.hasMore || page.nextAfter <= after) { if ((frames.at(-1)?.seq ?? -1) < limit) throw new Error('История обрывается до сохранённого снимка.'); break; }
      after = page.nextAfter;
      if (frames.length > 100_000) throw new Error('Выберите более короткий прогон для просмотра в браузере.');
    }
    return frames;
  }
  async loadHistory() {
    const id = this.runId; if (!id) throw new Error('Выберите прогон.');
    const frames = await this.readHistory(id); if (id !== this.runId) return [];
    this.history = frames; for (const frame of frames) this.collectEvents(frame, false); this.renderEvents();
    input('replay-position').max = String(Math.max(0, frames.length - 1)); this.updateControls(); return frames;
  }
  async replay(seq: number) {
    if (!this.runId) throw new Error('Выберите прогон.');
    this.stopPlayback(); const id = this.runId;
    const frame = this.history.find(f => f.seq === seq) ?? await this.client.replay(id, seq);
    if (id !== this.runId) return;
    if (!isFrame(frame) || frame.runId !== id || frame.seq !== seq) throw new Error('Некорректный кадр записи.');
    this.replaying = true; this.display(frame); this.drawTrend(this.history.length ? this.history : [frame], this.comparison); this.updateControls(); return frame;
  }
  live() { this.stopPlayback(); this.replaying = false; this.comparison = []; if (this.frame) this.display(this.status === 'connected' ? this.frame : offlineFrame(this.frame)); this.drawTrend(this.liveHistory); this.updateControls(); }
  private stopPlayback() { clearTimeout(this.playback); this.playback = undefined; button('replay-play').textContent = 'Воспроизвести'; }
  private play() {
    if (!this.history.length) return;
    let index = this.replaying ? this.history.findIndex(f => f.seq === this.displayed?.seq) : -1;
    if (index >= this.history.length - 1) index = -1;
    this.replaying = true; button('replay-play').textContent = 'Пауза записи';
    const tick = () => {
      const frame = this.history[++index];
      if (!frame) { this.stopPlayback(); this.updateControls(); return; }
      this.display(frame); this.drawTrend(this.history, this.comparison); this.updateControls();
      const next = this.history[index + 1];
      if (next) this.playback = setTimeout(tick, Math.max(16, next.simTimeMs - frame.simTimeMs)); else this.stopPlayback();
    }; tick();
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
  selectionChanged() { this.commandSignature = ''; this.updateControls(); if (this.displayed) this.display(this.displayed); }
  private updateControls() {
    const connected = this.status === 'connected', selected = !!this.currentRun;
    const labels = { disconnected: this.active ? 'Связь отключена' : 'Локальный предпросмотр', connecting: 'Подключение…', connected: 'Подключено', reconnecting: 'Связь потеряна · восстановление…', error: 'Ошибка подключения' };
    $('connection-status').textContent = `${labels[this.status]}${this.message ? ` · ${this.message}` : ''}`; $('connection-status').dataset.status = this.status;
    button('connect-server').textContent = this.client.config ? 'Отключиться' : 'Подключиться';
    for (const id of ['create-run', 'refresh-runs']) button(id).disabled = !connected;
    choose('run-select').disabled = !connected; choose('compare-run').disabled = !connected || !selected;
    for (const id of ['history-load', 'compare-history']) button(id).disabled = !connected || !selected;
    button('replay-play').disabled = !this.history.length; input('replay-position').disabled = !this.history.length;
    button('replay-live').disabled = !selected || !this.replaying;
    $('run-label').textContent = this.currentRun ? `${this.currentRun.label} · ${this.replaying ? 'запись' : this.currentRun.status === 'completed' ? 'завершён' : 'эфир'} · синтетика` : 'Синтетические данные';
    const target = this.target(), node = this.host.compiled()?.scene.nodes.find(n => n.id === target), commands = node ? catalog[node.kind].commands ?? {} : {};
    const disabled = !connected || !selected || this.replaying || this.currentRun?.status === 'completed';
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
      fact.textContent = `${modes[equipment.facts.mode] ?? equipment.facts.mode} · ${alarms[equipment.facts.alarm]} · Экземпляр ${equipment.instanceId}`; $('runtime-metrics').append(fact);
      for (const [name, signal] of Object.entries(equipment.signals)) {
        const field = document.createElement('span'); field.className = 'signal-value'; field.dataset.signal = name; field.dataset.quality = signal.quality;
        const value = signal.quality !== 'good' || signal.value === null ? '—' : typeof signal.value === 'number' ? signal.value.toFixed(signal.unit === 'rpm' ? 0 : 2) : typeof signal.value === 'boolean' ? signal.value ? 'Да' : 'Нет' : String(signal.value);
        const label = definition ? catalog[definition.kind].signals?.[name]?.label ?? name : name;
        field.textContent = `${label}: ${value} ${units[signal.unit] ?? signal.unit}${signal.quality !== 'good' ? ` · ${qualities[signal.quality]}` : ''}`; $('runtime-metrics').append(field);
      }
    }
    $('replay-time').textContent = `${seconds(frame.simTimeMs)} · #${frame.seq}`;
    input('replay-position').value = String(Math.max(0, this.history.findIndex(f => f.seq === frame.seq)));
    const q = this.flow(frame); $('flow-readout').textContent = q === null ? '—' : q.toFixed(1); $('flow-label').textContent = `Расход · ${this.replaying ? 'запись' : 'сервер'}`;
  }
  private flow(frame: RuntimeFrame) { return numeric(Object.values(frame.flows)[0]); }
  private collectEvents(frame: RuntimeFrame, render = true) { let changed = false; for (const event of frame.events) if (!this.events.has(event.id)) { this.events.set(event.id, event); changed = true; } if (render && changed) this.renderEvents(); }
  private renderEvents() {
    $('event-count').textContent = String(this.events.size);
    const events = [...this.events.values()].sort((a, b) => b.seq - a.seq).slice(0, 100);
    $('runtime-events').replaceChildren(...events.map(e => { const li = document.createElement('li'); li.textContent = `${seconds(e.simTimeMs)} · ${e.equipmentId ?? 'Установка'} · ${e.message}`; return li; }));
  }
  private drawTrend(primary: RuntimeFrame[], secondary: RuntimeFrame[] = []) {
    const svg = document.getElementById('trend')!; svg.replaceChildren();
    for (const y of [8, 28, 48]) svg.append(svgEl('line', { x1: 0, y1: y, x2: 400, y2: y, stroke: '#dce5e9' }));
    const end = Math.max(primary.at(-1)?.simTimeMs ?? 0, secondary.at(-1)?.simTimeMs ?? 0, 1000), start = this.replaying ? 0 : Math.max(0, end - 60_000);
    const maxFlow = [...primary, ...secondary].reduce((max, f) => Math.max(max, Math.abs(this.flow(f) ?? 0)), 12);
    const path = (frames: RuntimeFrame[], color: string) => {
      let d = '', gap = true;
      for (const frame of frames) { if (frame.simTimeMs < start) continue; const q = this.flow(frame); if (q === null) { gap = true; continue; } d += `${gap ? 'M' : 'L'}${((frame.simTimeMs - start) / (end - start) * 400).toFixed(1)} ${(28 - q / maxFlow * 23).toFixed(1)}`; gap = false; }
      svg.append(svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.8, 'vector-effect': 'non-scaling-stroke' }));
    };
    path(primary, '#218da4'); if (secondary.length) path(secondary, '#b87935');
    $('trend-label').textContent = secondary.length ? 'Текущий — бирюзовый · сравнение — охра' : this.replaying ? 'История расхода · запись' : 'История расхода · сервер';
    $('trend-scale').textContent = `${seconds(end - start)} · ±${maxFlow.toFixed(0)} м³/ч`;
  }
  dispose() { this.client.disconnect(); this.stopPlayback(); }
}
