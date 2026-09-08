import type { CommandReceipt, CreateRun, EquipmentCommand, HistoryPage, RunSummary, RuntimeConfig, RuntimeFrame, Signal } from './protocol';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
function signal(v: unknown): v is Signal {
  if (!record(v) || !['good', 'stale', 'bad', 'offline'].includes(String(v.quality)) || typeof v.unit !== 'string' || typeof v.timestamp !== 'number' || !Number.isFinite(v.timestamp)) return false;
  return ['number', 'boolean', 'string'].includes(String(v.type)) && (v.value === null || (typeof v.value === v.type && (v.type !== 'number' || Number.isFinite(v.value))));
}
/** Validate the wire before allowing it into a view; unknown is never coerced to zero. */
export function isFrame(v: unknown): v is RuntimeFrame {
  if (!record(v) || !['snapshot', 'update'].includes(String(v.type)) || typeof v.runId !== 'string' || !Number.isSafeInteger(v.seq) || Number(v.seq) < 0 || !Number.isFinite(v.simTimeMs) || !Number.isFinite(v.timestamp) || !record(v.equipment) || !record(v.flows) || !Array.isArray(v.events)) return false;
  if (Object.keys(v.equipment).length > 48 || Object.keys(v.flows).length > 144) return false;
  return Object.values(v.flows).every(s => signal(s) && s.type === 'number') && Object.entries(v.equipment).every(([id, e]) => record(e) && e.positionId === id && typeof e.instanceId === 'string' && record(e.facts) && typeof e.facts.mode === 'string' && ['none', 'warning', 'trip'].includes(String(e.facts.alarm)) && record(e.signals) && Object.values(e.signals).every(signal)) && v.events.every(e => record(e) && typeof e.id === 'string' && typeof e.type === 'string' && typeof e.message === 'string' && Number.isSafeInteger(e.seq) && Number.isFinite(e.simTimeMs) && Number.isFinite(e.timestamp));
}
export function offlineFrame(frame: RuntimeFrame): RuntimeFrame {
  const copy = structuredClone(frame);
  for (const e of Object.values(copy.equipment)) for (const s of Object.values(e.signals)) { s.value = null; s.quality = 'offline'; }
  for (const s of Object.values(copy.flows)) { s.value = null; s.quality = 'offline'; }
  return copy;
}
export function validateDestination(config: RuntimeConfig): RuntimeConfig {
  const url = new URL(config.server);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new Error('URL: HTTPS или локальный HTTP; без пароля, query и fragment.');
  if (!/^[\p{L}\p{N}_.-]{1,64}$/u.test(config.project) || (config.run && !/^[a-zA-Z0-9_.-]{1,80}$/.test(config.run))) throw new Error('Недопустимый ID проекта или прогона.');
  return { ...config, server: url.href.replace(/\/$/, '') };
}
function isRun(value: unknown): value is RunSummary {
  return record(value) && typeof value.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value.id) && typeof value.projectId === 'string' && typeof value.label === 'string' && value.label.length <= 120 && ['running', 'completed'].includes(String(value.status)) && Number.isSafeInteger(value.seq) && Number(value.seq) >= 0 && Number.isFinite(value.simTimeMs) && Number.isFinite(value.createdAt) && typeof value.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(value.sourceHash) && value.synthetic === true;
}
export class RuntimeClient {
  config: RuntimeConfig | null = null;
  frame: RuntimeFrame | null = null;
  status: ConnectionStatus = 'disconnected';
  onFrame: (frame: RuntimeFrame) => void = () => {};
  onStatus: (status: ConnectionStatus, message: string) => void = () => {};
  private token = '';
  private generation = 0;
  private stream: AbortController | null = null;
  private requests = new Set<AbortController>();
  private retry: ReturnType<typeof setTimeout> | undefined;
  private retryCount = 0;
  private setStatus(status: ConnectionStatus, message = '') { this.status = status; this.onStatus(status, message); }
  async connect(config: RuntimeConfig, token: string): Promise<RunSummary[]> {
    const destination = validateDestination(config), credential = token.trim();
    if (!credential) throw new Error('Введите токен из локальной консоли сервера.');
    this.disconnect(); this.config = destination; this.token = credential; const generation = this.generation;
    this.setStatus('connecting');
    try { const runs = await this.runs(); this.setStatus('connected'); return runs; }
    catch (error) { if (generation === this.generation) this.setStatus('error', String(error instanceof Error ? error.message : error)); throw error; }
  }
  disconnect() {
    this.generation++; this.stream?.abort(); this.stream = null; clearTimeout(this.retry);
    for (const request of this.requests) request.abort(); this.requests.clear();
    this.token = ''; this.config = null; this.setStatus('disconnected');
  }
  async request<T>(path: string, body?: unknown): Promise<T> {
    if (!this.config || !this.token) throw new Error('Подключитесь к серверу.');
    const controller = new AbortController(), generation = this.generation;
    this.requests.add(controller); const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(this.config.server + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
      const result = await response.json();
      if (generation !== this.generation) throw new Error('Подключение изменилось.');
      if (!response.ok) throw new Error(result.error?.message ?? result.error ?? `HTTP ${response.status}`);
      return result as T;
    } finally { clearTimeout(timeout); this.requests.delete(controller); }
  }
  async runs() {
    const data = await this.request<{ runs: RunSummary[] }>(`/api/runs?projectId=${encodeURIComponent(this.config!.project)}`);
    if (!Array.isArray(data.runs) || data.runs.length > 100 || !data.runs.every(isRun)) throw new Error('Некорректный список прогонов.');
    return data.runs;
  }
  private async detail(path: string, body?: unknown) {
    const result = await this.request<{ run: RunSummary; snapshot: RuntimeFrame }>(path, body);
    if (!isRun(result.run) || !isFrame(result.snapshot) || result.run.id !== result.snapshot.runId || result.run.seq !== result.snapshot.seq) throw new Error('Некорректные сведения о прогоне.');
    return result;
  }
  create(input: CreateRun) { return this.detail('/api/runs', input); }
  run(id: string) { return this.detail(`/api/runs/${encodeURIComponent(id)}`); }
  complete(id: string) { return this.detail(`/api/runs/${encodeURIComponent(id)}/complete`, {}); }
  command(id: string, command: EquipmentCommand) { return this.request<CommandReceipt>(`/api/runs/${encodeURIComponent(id)}/commands`, command); }
  history(id: string, after: number) { return this.request<HistoryPage>(`/api/runs/${encodeURIComponent(id)}/history?after=${after}&limit=500`); }
  replay(id: string, seq: number) { return this.request<RuntimeFrame>(`/api/runs/${encodeURIComponent(id)}/replay?seq=${seq}`); }
  research(id: string) { return this.request<unknown>(`/api/runs/${encodeURIComponent(id)}/research`); }
  subscribe(runId: string, initial: RuntimeFrame) {
    if (!isFrame(initial) || initial.runId !== runId) throw new Error('Некорректный снимок прогона.');
    this.generation++; this.stream?.abort(); clearTimeout(this.retry); this.retryCount = 0;
    this.config = { ...this.config!, run: runId }; this.frame = initial; this.onFrame(initial);
    void this.consume(this.generation, runId);
  }
  private async consume(generation: number, runId: string) {
    if (!this.config || generation !== this.generation) return;
    const controller = new AbortController(); this.stream = controller;
    let watchdog: ReturnType<typeof setTimeout>;
    const touch = () => { clearTimeout(watchdog); watchdog = setTimeout(() => controller.abort(), 15_000); }; touch();
    try {
      const response = await fetch(`${this.config.server}/api/runs/${encodeURIComponent(runId)}/events?after=${this.frame?.seq ?? -1}`, { headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' }, signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
      if (!response.ok || !response.body) throw new Error(`Поток: HTTP ${response.status}`);
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', first = true;
      while (true) {
        const part = await reader.read(); if (part.done) throw new Error('Поток закрыт сервером.'); touch();
        if (generation !== this.generation) return;
        buffer += decoder.decode(part.value, { stream: true }).replace(/\r\n/g, '\n');
        if (buffer.length > 2_000_000) throw new Error('Слишком большой кадр.');
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
          if (!data) continue;
          const frame: unknown = JSON.parse(data);
          if (!isFrame(frame) || frame.runId !== runId) throw new Error('Некорректный кадр или другой прогон.');
          if (first && frame.type !== 'snapshot') throw new Error('Ожидался начальный снимок.');
          if (!first && frame.seq <= (this.frame?.seq ?? -1)) continue;
          if (!first && frame.seq !== this.frame!.seq + 1) throw new Error('Пропуск обновления: получаем новый снимок.');
          if (first && frame.seq < (this.frame?.seq ?? -1)) throw new Error('Сервер прислал устаревший снимок.');
          first = false; this.frame = frame; this.retryCount = 0; this.setStatus('connected'); this.onFrame(frame);
        }
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.setStatus('reconnecting', error instanceof Error ? error.message : String(error));
      if (this.frame) this.onFrame(offlineFrame(this.frame));
      this.retry = setTimeout(() => void this.consume(generation, runId), Math.min(5000, 500 * 2 ** Math.min(4, this.retryCount++)));
    } finally { clearTimeout(watchdog!); controller.abort(); }
  }
}
