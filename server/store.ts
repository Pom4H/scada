import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CommandReceipt, HistoryPage, RunDetail, RuntimeFrame, HistoryRange, TrendPoint } from '../src/runtime/protocol';

export class StorageError extends Error { constructor(cause: unknown) { super('Runtime storage failed', { cause }); } }
export interface PersistedRun { manifest: RunDetail; checkpoint: unknown }
export interface StoredCommand { payload: string; receipt: CommandReceipt }
export class RunStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, checkpoint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS frames (run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL, frame TEXT NOT NULL, sim_time_ms INTEGER NOT NULL, PRIMARY KEY(run_id,seq));
      CREATE TABLE IF NOT EXISTS commands (run_id TEXT NOT NULL REFERENCES runs(id), command_id TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(run_id,command_id));
      CREATE TABLE IF NOT EXISTS research_events (run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL, events TEXT NOT NULL, PRIMARY KEY(run_id,seq));`);
    const columns = this.db.prepare('PRAGMA table_info(frames)').all();
    if (!columns.some(column => column.name === 'sim_time_ms')) {
      this.db.exec("BEGIN IMMEDIATE; ALTER TABLE frames ADD COLUMN sim_time_ms INTEGER NOT NULL DEFAULT 0; UPDATE frames SET sim_time_ms=json_extract(frame,'$.simTimeMs'); COMMIT;");
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS frames_time ON frames(run_id,sim_time_ms,seq)');
  }
  load(): PersistedRun[] {
    return this.db.prepare('SELECT manifest,checkpoint FROM runs ORDER BY rowid').all().map(row => ({ manifest: JSON.parse(String(row.manifest)), checkpoint: JSON.parse(String(row.checkpoint)) }));
  }
  persist(manifest: RunDetail, checkpoint: unknown, frame: RuntimeFrame, privateEvents: unknown[], command?: { id: string; payload: string; receipt: CommandReceipt }): void {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db.prepare('INSERT INTO runs(id,manifest,checkpoint) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET manifest=excluded.manifest,checkpoint=excluded.checkpoint').run(manifest.id, JSON.stringify(manifest), JSON.stringify(checkpoint));
      this.db.prepare('INSERT INTO frames(run_id,seq,frame,sim_time_ms) VALUES(?,?,?,?)').run(manifest.id, frame.seq, JSON.stringify(frame), frame.simTimeMs);
      if (privateEvents.length) this.db.prepare('INSERT INTO research_events(run_id,seq,events) VALUES(?,?,?)').run(manifest.id, frame.seq, JSON.stringify(privateEvents));
      if (command) this.db.prepare('INSERT INTO commands(run_id,command_id,payload,receipt) VALUES(?,?,?,?)').run(manifest.id, command.id, command.payload, JSON.stringify(command.receipt));
      this.db.exec('COMMIT');
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* BEGIN itself may have failed. */ } throw new StorageError(error); }
  }
  frame(runId: string, seq: number): RuntimeFrame | undefined {
    const row = this.db.prepare('SELECT frame FROM frames WHERE run_id=? AND seq=?').get(runId, seq);
    return row ? JSON.parse(String(row.frame)) : undefined;
  }
  command(runId: string, id: string): StoredCommand | undefined {
    const row = this.db.prepare('SELECT payload,receipt FROM commands WHERE run_id=? AND command_id=?').get(runId, id);
    return row ? { payload: String(row.payload), receipt: JSON.parse(String(row.receipt)) } : undefined;
  }
  history(runId: string, after: number, limit: number, range?: HistoryRange): HistoryPage {
    const rows = range
      ? this.db.prepare('SELECT frame FROM frames WHERE run_id=? AND sim_time_ms>=? AND sim_time_ms<=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?').all(runId, range.fromMs, range.toMs, after, range.untilSeq, limit + 1)
      : this.db.prepare('SELECT frame FROM frames WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(runId, after, limit + 1);
    const frames = rows.slice(0, limit).map(row => JSON.parse(String(row.frame)) as RuntimeFrame);
    return { frames, nextAfter: frames.at(-1)?.seq ?? after, hasMore: rows.length > limit };
  }
  /** Bounded min/max overview. A bucket containing unknown samples is conservatively shown as a gap. */
  trend(runId: string, signalPath: string, range: HistoryRange, maxPoints: number): TrendPoint[] {
    const buckets = Math.max(1, Math.floor(maxPoints / 4));
    const rows = this.db.prepare(`WITH samples AS (
      SELECT seq,sim_time_ms,
        CASE WHEN json_extract(frame,? || '.quality')='good' THEN json_extract(frame,? || '.value') ELSE NULL END AS value,
        CAST((sim_time_ms-?)*? / (?+1) AS INTEGER) AS bucket
      FROM frames WHERE run_id=? AND sim_time_ms>=? AND sim_time_ms<=? AND seq<=?
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER(PARTITION BY bucket ORDER BY seq) AS first,
        ROW_NUMBER() OVER(PARTITION BY bucket ORDER BY seq DESC) AS last,
        ROW_NUMBER() OVER(PARTITION BY bucket ORDER BY value,seq) AS low,
        ROW_NUMBER() OVER(PARTITION BY bucket ORDER BY value DESC,seq) AS high,
        MAX(value IS NULL) OVER(PARTITION BY bucket) AS gap FROM samples
    ) SELECT seq,sim_time_ms,CASE WHEN gap THEN NULL ELSE value END AS value
      FROM ranked WHERE (gap AND first=1) OR (NOT gap AND (first=1 OR last=1 OR low=1 OR high=1)) ORDER BY seq`)
      .all(signalPath, signalPath, range.fromMs, buckets, range.toMs-range.fromMs, runId, range.fromMs, range.toMs, range.untilSeq);
    return rows.map(row => ({ seq: Number(row.seq), simTimeMs: Number(row.sim_time_ms), value: row.value === null ? null : Number(row.value) }));
  }
  researchEvents(runId: string, after = -1, limit = 500): unknown[] {
    return this.db.prepare('SELECT seq,events FROM research_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(runId, after, limit).map(row => ({ seq: row.seq, events: JSON.parse(String(row.events)) }));
  }
  commands(runId: string, after = -1, limit = 500): unknown[] {
    return this.db.prepare('SELECT payload,receipt FROM commands WHERE run_id=? AND json_extract(receipt,\'$.seq\')>? ORDER BY json_extract(receipt,\'$.seq\') LIMIT ?').all(runId, after, limit).map(row => ({ command: JSON.parse(String(row.payload)), receipt: JSON.parse(String(row.receipt)) }));
  }
  close(): void { this.db.close(); }
}
