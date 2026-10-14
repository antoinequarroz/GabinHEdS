import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { AuthResult, Device, DeviceKind, DeviceRole, Marker, MediaAsset, PairingCode, Project, ProjectMediaLink, RoomConfig, Take } from '@gabin/shared';

export interface PrivateRoom extends RoomConfig { obsPassword: string; liveKey: string }
interface DeviceRow { id: string; token_hash: string; json: string }
interface PairRow { code_hash: string; json: string }

export const hashSecret = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Local private database. Tokens are hashed; private room data never enters public state. */
export class Store {
  private readonly db: DatabaseSync;
  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    const file = path.join(dataDir, 'studio.sqlite');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pairings (code_hash TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (device_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(device_id, request_id));
    `);
  }
  close(): void { this.db.close(); }
  list<T>(kind: string): T[] {
    const rows = this.db.prepare('SELECT json FROM documents WHERE kind = ? ORDER BY rowid DESC').all(kind) as { json: string }[];
    return rows.map((row) => JSON.parse(row.json) as T);
  }
  get<T>(kind: string, id: string): T | null {
    const row = this.db.prepare('SELECT json FROM documents WHERE kind = ? AND id = ?').get(kind, id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as T : null;
  }
  put<T extends { id: string }>(kind: string, value: T): void {
    this.db.prepare('INSERT INTO documents(kind,id,json) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json').run(kind, value.id, JSON.stringify(value));
  }
  setting<T>(key: string): T | null {
    const row = this.db.prepare('SELECT json FROM settings WHERE key=?').get(key) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as T : null;
  }
  setSetting(key: string, value: unknown): void {
    if (value === null) this.db.prepare('DELETE FROM settings WHERE key=?').run(key);
    else this.db.prepare('INSERT INTO settings(key,json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json').run(key, JSON.stringify(value));
  }
  projects(): Project[] { return this.list<Project>('project'); }
  takes(): Take[] { return this.list<Take>('take').sort((a, b) => b.startedAt.localeCompare(a.startedAt)); }
  markers(): Marker[] { return this.list<Marker>('marker').sort((a, b) => a.offsetMs - b.offsetMs); }
  library(): MediaAsset[] { return this.list<{ id: string; asset: MediaAsset }>('mediaAsset').map(record => record.asset); }
  projectMedia(): Record<string, ProjectMediaLink[]> {
    return Object.fromEntries(this.list<{ id: string; links: ProjectMediaLink[] }>('projectMedia').map(record => [record.id, record.links]));
  }
  room(): PrivateRoom | null { return this.setting<PrivateRoom>('room'); }
  saveRoom(room: PrivateRoom): void { this.setSetting('room', room); }
  publicRoom(): RoomConfig {
    const { obsPassword: _password, liveKey: _liveKey, ...room } = this.room()!;
    return room;
  }

  createDevice(name: string, kind: DeviceKind, role: DeviceRole, persistent = false): AuthResult {
    const now = new Date();
    const device: Device = { id: randomUUID(), name, kind, role, createdAt: now.toISOString(),
      expiresAt: persistent ? null : new Date(now.getTime() + 30 * 24 * 3600_000).toISOString() };
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO devices(id,token_hash,json) VALUES(?,?,?)').run(device.id, hashSecret(token), JSON.stringify(device));
    return { token, device };
  }
  deviceForToken(token: string): Device | null {
    const row = this.db.prepare('SELECT json FROM devices WHERE token_hash=?').get(hashSecret(token)) as Pick<DeviceRow, 'json'> | undefined;
    const device: Device | null = row ? JSON.parse(row.json) : null;
    return device && (!device.expiresAt || Date.parse(device.expiresAt) > Date.now()) ? device : null;
  }
  device(id: string): Device | null {
    const row = this.db.prepare('SELECT json FROM devices WHERE id=?').get(id) as Pick<DeviceRow, 'json'> | undefined;
    const device: Device | null = row ? JSON.parse(row.json) : null;
    return device && (!device.expiresAt || Date.parse(device.expiresAt) > Date.now()) ? device : null;
  }
  devices(): Device[] {
    return (this.db.prepare('SELECT json FROM devices ORDER BY rowid DESC').all() as Pick<DeviceRow, 'json'>[])
      .map((row) => JSON.parse(row.json) as Device).filter((device) => !device.expiresAt || Date.parse(device.expiresAt) > Date.now());
  }
  revoke(id: string): boolean { return this.db.prepare('DELETE FROM devices WHERE id=?').run(id).changes > 0; }
  createPairing(role: DeviceRole, kind: DeviceKind): PairingCode {
    const expired = (this.db.prepare('SELECT code_hash,json FROM pairings').all() as unknown as PairRow[])
      .filter((row) => Date.parse((JSON.parse(row.json) as PairingCode).expiresAt) <= Date.now());
    for (const row of expired) this.db.prepare('DELETE FROM pairings WHERE code_hash=?').run(row.code_hash);
    let code = String(randomInt(100000, 1000000));
    while (this.db.prepare('SELECT 1 FROM pairings WHERE code_hash=?').get(hashSecret(code))) code = String(randomInt(100000, 1000000));
    const pairing = { code, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), role, kind };
    // The plaintext code is returned once, never stored.
    this.db.prepare('INSERT INTO pairings(code_hash,json) VALUES(?,?)').run(hashSecret(code), JSON.stringify({ ...pairing, code: '' }));
    return pairing;
  }
  usePairing(code: string, name: string, kind: DeviceKind): AuthResult | null {
    const hash = hashSecret(code);
    const row = this.db.prepare('SELECT json FROM pairings WHERE code_hash=?').get(hash) as Pick<PairRow, 'json'> | undefined;
    if (!row) return null;
    const pairing = JSON.parse(row.json) as PairingCode;
    if (Date.parse(pairing.expiresAt) <= Date.now() || pairing.kind !== kind) return null;
    this.db.prepare('DELETE FROM pairings WHERE code_hash=?').run(hash);
    return this.createDevice(name, kind, pairing.role);
  }
  command(deviceId: string, requestId: string): { fingerprint: string; result: unknown } | null {
    const row = this.db.prepare('SELECT fingerprint,json FROM commands WHERE device_id=? AND request_id=?').get(deviceId, requestId) as { fingerprint: string; json: string } | undefined;
    return row ? { fingerprint: row.fingerprint, result: JSON.parse(row.json) } : null;
  }
  rememberCommand(deviceId: string, requestId: string, fingerprint: string, result: unknown): void {
    this.db.prepare('INSERT INTO commands(device_id,request_id,fingerprint,json,created_at) VALUES(?,?,?,?,?)').run(deviceId, requestId, fingerprint, JSON.stringify(result), new Date().toISOString());
    // Keep bounded replay receipts, not full copies of every historical state.
    this.db.prepare('DELETE FROM commands WHERE rowid NOT IN (SELECT rowid FROM commands ORDER BY rowid DESC LIMIT 2000)').run();
  }
}
