import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CommandReceipt, HistoryPage, RunDetail, RuntimeFrame } from '../src/runtime/protocol';

export interface PersistedRun { manifest: RunDetail; checkpoint: unknown }
export interface StoredCommand { payload: string; receipt: CommandReceipt }
export class RunStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, checkpoint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS frames (run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL, frame TEXT NOT NULL, PRIMARY KEY(run_id,seq));
      CREATE TABLE IF NOT EXISTS commands (run_id TEXT NOT NULL REFERENCES runs(id), command_id TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(run_id,command_id));
      CREATE TABLE IF NOT EXISTS research_events (run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL, events TEXT NOT NULL, PRIMARY KEY(run_id,seq));`);
  }
  load(): PersistedRun[] {
    return this.db.prepare('SELECT manifest,checkpoint FROM runs ORDER BY rowid').all().map(row => ({ manifest: JSON.parse(String(row.manifest)), checkpoint: JSON.parse(String(row.checkpoint)) }));
  }
  persist(manifest: RunDetail, checkpoint: unknown, frame: RuntimeFrame, privateEvents: unknown[], command?: { id: string; payload: string; receipt: CommandReceipt }): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO runs(id,manifest,checkpoint) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET manifest=excluded.manifest,checkpoint=excluded.checkpoint').run(manifest.id, JSON.stringify(manifest), JSON.stringify(checkpoint));
      this.db.prepare('INSERT INTO frames(run_id,seq,frame) VALUES(?,?,?)').run(manifest.id, frame.seq, JSON.stringify(frame));
      if (privateEvents.length) this.db.prepare('INSERT INTO research_events(run_id,seq,events) VALUES(?,?,?)').run(manifest.id, frame.seq, JSON.stringify(privateEvents));
      if (command) this.db.prepare('INSERT INTO commands(run_id,command_id,payload,receipt) VALUES(?,?,?,?)').run(manifest.id, command.id, command.payload, JSON.stringify(command.receipt));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  frame(runId: string, seq: number): RuntimeFrame | undefined {
    const row = this.db.prepare('SELECT frame FROM frames WHERE run_id=? AND seq=?').get(runId, seq);
    return row ? JSON.parse(String(row.frame)) : undefined;
  }
  command(runId: string, id: string): StoredCommand | undefined {
    const row = this.db.prepare('SELECT payload,receipt FROM commands WHERE run_id=? AND command_id=?').get(runId, id);
    return row ? { payload: String(row.payload), receipt: JSON.parse(String(row.receipt)) } : undefined;
  }
  history(runId: string, after: number, limit: number): HistoryPage {
    const rows = this.db.prepare('SELECT frame FROM frames WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(runId, after, limit + 1);
    const frames = rows.slice(0, limit).map(row => JSON.parse(String(row.frame)) as RuntimeFrame);
    return { frames, nextAfter: frames.at(-1)?.seq ?? after, hasMore: rows.length > limit };
  }
  researchEvents(runId: string, after = -1, limit = 500): unknown[] {
    return this.db.prepare('SELECT seq,events FROM research_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(runId, after, limit).map(row => ({ seq: row.seq, events: JSON.parse(String(row.events)) }));
  }
  commands(runId: string, after = -1, limit = 500): unknown[] {
    return this.db.prepare('SELECT payload,receipt FROM commands WHERE run_id=? AND json_extract(receipt,\'$.seq\')>? ORDER BY json_extract(receipt,\'$.seq\') LIMIT ?').all(runId, after, limit).map(row => ({ command: JSON.parse(String(row.payload)), receipt: JSON.parse(String(row.receipt)) }));
  }
  close(): void { this.db.close(); }
}
