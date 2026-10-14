import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { GuestIceServer, GuestInvitation, GuestPeer, GuestPeerRole, GuestRoomState, GuestServerMessage, GuestSession, GuestSlot, Project } from '@gabin/shared';
import { Store, hashSecret } from './store.js';
import { ApiFailure, object, string } from './validation.js';

const SESSION_MS = 6 * 3600_000;
const INVITATION_MS = 24 * 3600_000;
const SOURCE_MS = 5 * 60_000;
const tokenPattern = /^[a-zA-Z0-9_-]{43}$/;

export interface GuestConfig {
  publicUrl?: string;
  port?: number;
  stunUrls?: string[];
  turnUrls?: string[];
  turnSecret?: string;
  /** Only for the loopback tunnel, with a proxy overwriting X-Nino-Client-IP. */
  trustLocalProxy?: boolean;
  /** Injectable clock for expiry tests. Authentication uses the same clock everywhere. */
  now?: () => number;
}
export function readGuestConfig(): GuestConfig {
  const split = (value: string | undefined): string[] => value ? value.split(',').map(item => item.trim()).filter(Boolean) : [];
  return { publicUrl: process.env.NINO_GUEST_PUBLIC_URL || undefined, port: process.env.NINO_GUEST_PORT ? Number(process.env.NINO_GUEST_PORT) : 4312,
    stunUrls: split(process.env.NINO_GUEST_STUN_URLS), turnUrls: split(process.env.NINO_GUEST_TURN_URLS), turnSecret: process.env.NINO_GUEST_TURN_SECRET || undefined,
    trustLocalProxy: process.env.NINO_GUEST_TRUST_LOCAL_PROXY === '1' };
}
interface InvitationRecord { id: string; hash: string; owner: string; expiresAt: number; used: boolean; }
interface SessionRecord { tokenHash: string; peer: GuestPeer; projectId: string; owner: string; expiresAt: number; socket: WebSocket | null; alive: boolean; }
interface SourceRecord { hash: string; guestId: string; owner: string; expiresAt: number; }
interface Bucket { start: number; count: number; }

function secureBase(value: string | undefined, port: number): string {
  const url = new URL(value || `http://127.0.0.1:${port}`);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('NINO_GUEST_PUBLIC_URL doit être une origine HTTPS, ou HTTP sur localhost pour un test local.');
  }
  return url.origin;
}
function iceUrls(values: string[] | undefined, protocols: readonly string[]): string[] {
  return (values || []).map(value => {
    if (value.length > 512 || /[\s\r\n\0]/.test(value)) throw new Error('Adresse ICE invalide.');
    const url = new URL(value);
    if (!protocols.includes(url.protocol) || url.username || url.password || !url.pathname || url.hash) throw new Error('Adresse ICE invalide.');
    return value;
  });
}

/** Invitations persisted as hashes; live grants, media reports and sessions are deliberately ephemeral. */
export class GuestService {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly sourceTickets = new Map<string, SourceRecord>();
  /** Initial source negotiation is bounded; a confirmed source loss is immediate. */
  private readonly sourcePending = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly publicBase: string;
  private readonly localBase: string;
  private readonly stun: string[];
  private readonly turn: string[];
  private readonly timer: ReturnType<typeof setInterval>;
  private bridge: SessionRecord | null = null;
  private bridgeReady = false;
  private bridgeError: string | null = null;
  private closed = false;
  readonly publicUrl: string;
  readonly port: number;

  constructor(private readonly store: Store, readonly config: GuestConfig = readGuestConfig()) {
    const port = config.port ?? 4312;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port invité invalide.');
    this.publicBase = secureBase(config.publicUrl, port);
    this.publicUrl = this.publicBase;
    this.port = port;
    this.localBase = `http://127.0.0.1:${port}`;
    this.now = config.now || Date.now;
    this.stun = iceUrls(config.stunUrls, ['stun:']);
    this.turn = iceUrls(config.turnUrls, ['turn:', 'turns:']);
    if (this.turn.length && (!config.turnSecret || config.turnSecret.length < 16)) throw new Error('TURN requiert un secret temporaire NINO_GUEST_TURN_SECRET d’au moins 16 caractères.');
    for (const guest of this.store.list<GuestSlot>('guest')) {
      const invitation = this.store.get<InvitationRecord>('guestInvitation', guest.id);
      guest.joined = guest.mediaReady = guest.sourceReady = guest.admitted = false;
      guest.muted = true;
      guest.error = null;
      if (guest.status !== 'removed') guest.status = invitation && !invitation.used && invitation.expiresAt > this.now() ? 'invited' : 'disconnected';
      this.store.put('guest', guest);
    }
    this.timer = setInterval(() => this.sweep(true), 15_000);
    this.timer.unref();
  }

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(): void {
    for (const listener of this.listeners) listener();
    for (const session of this.sessions.values()) if (session.socket?.readyState === 1) this.send(session, { type: 'room', peers: this.peers(session), room: this.room(session.projectId) });
  }
  private send(session: SessionRecord, value: GuestServerMessage): void {
    if (session.socket?.readyState === 1) {
      if (session.socket.bufferedAmount > 256 * 1024) session.socket.close(4008, 'Connexion trop lente');
      else session.socket.send(JSON.stringify(value));
    }
  }
  private room(projectId: string): GuestRoomState {
    const bridge = this.bridge?.projectId === projectId ? this.bridge : null;
    return { projectId, bridge: { connected: !!bridge?.socket && bridge.socket.readyState === 1, mediaReady: !!bridge?.socket && this.bridgeReady, error: bridge ? this.bridgeError : null },
      guests: this.store.list<GuestSlot>('guest').filter(guest => guest.projectId === projectId).sort((a, b) => a.slot - b.slot) };
  }
  rooms(): Record<string, GuestRoomState> {
    this.sweep(false);
    return Object.fromEntries(this.store.projects().map(project => [project.id, this.room(project.id)]));
  }
  /** A browser may still be asking for capture permissions. Reserve the
   * production from the moment its bridge grant is issued, not only at WS open. */
  bridgeProjectId(): string | null { this.sweep(false); return this.bridge?.projectId ?? null; }
  getGuest(id: string): GuestSlot {
    const guest = this.store.get<GuestSlot>('guest', id);
    if (!guest || guest.status === 'removed') throw new ApiFailure(404, 'Invité introuvable.', 'GUEST_NOT_FOUND');
    return guest;
  }
  private project(id: string): Project {
    const project = this.store.get<Project>('project', id);
    if (!project || project.status === 'archived') throw new ApiFailure(404, 'Production introuvable ou archivée.', 'NOT_FOUND');
    return project;
  }
  private owner(id: string): void {
    const device = this.store.device(id);
    if (!device || device.role === 'viewer') throw new ApiFailure(401, 'Accès opérateur révoqué ou expiré.', 'UNAUTHENTICATED');
  }
  private status(guest: GuestSlot): void {
    if (guest.status === 'removed' || guest.status === 'invited') return;
    const returnReady = this.bridge?.projectId === guest.projectId && this.bridge.socket?.readyState === 1 && this.bridgeReady;
    guest.status = !guest.joined ? 'disconnected' : guest.admitted ? 'admitted' : guest.mediaReady && returnReady ? 'ready' : 'waiting';
  }
  private save(guest: GuestSlot): void {
    this.status(guest);
    if (JSON.stringify(this.store.get<GuestSlot>('guest', guest.id)) !== JSON.stringify(guest)) this.store.put('guest', guest);
  }
  invite(projectId: string, slot: 1 | 2, name: string, deviceId: string): GuestInvitation {
    this.owner(deviceId); this.project(projectId);
    if (slot !== 1 && slot !== 2) throw new ApiFailure(400, 'Deux places invitées sont disponibles.', 'INVALID_REQUEST');
    const previous = this.store.list<GuestSlot>('guest').find(guest => guest.projectId === projectId && guest.slot === slot);
    if (previous) this.disconnectGuest(previous.id, true, false);
    const id = previous?.id || randomUUID();
    const expiresAt = this.now() + INVITATION_MS;
    const token = randomBytes(32).toString('base64url');
    const guest: GuestSlot = { id, projectId, slot, name: string(name, 'nom de l’invité', 100), status: 'invited', joined: false, mediaReady: false, sourceReady: false, admitted: false, muted: true,
      sceneName: `Nino · Invité ${slot} · ${hashSecret(projectId).slice(0, 12)}`, inputName: `Nino · Invité ${slot} · ${hashSecret(projectId).slice(0, 12)}`, invitationExpiresAt: new Date(expiresAt).toISOString(), error: null };
    this.store.put('guest', guest);
    this.store.put<InvitationRecord>('guestInvitation', { id, hash: hashSecret(token), owner: deviceId, expiresAt, used: false });
    this.emit();
    return { guestId: id, slot, url: `${this.publicBase}/#guest/${token}`, expiresAt: guest.invitationExpiresAt! };
  }
  private invitation(token: unknown): { record: InvitationRecord; guest: GuestSlot } {
    if (typeof token !== 'string' || !tokenPattern.test(token)) throw new ApiFailure(401, 'Invitation invalide ou expirée.', 'INVITATION_REJECTED');
    const record = this.store.list<InvitationRecord>('guestInvitation').find(candidate => candidate.hash === hashSecret(token));
    if (!record || record.used || record.expiresAt <= this.now()) throw new ApiFailure(401, 'Invitation invalide, déjà utilisée ou expirée.', 'INVITATION_REJECTED');
    this.owner(record.owner);
    return { record, guest: this.getGuest(record.id) };
  }
  inspectInvitation(token: unknown): { guestId: string; name: string; title: string; slot: 1 | 2; expiresAt: string; available: true } {
    const { record, guest } = this.invitation(token);
    return { guestId: guest.id, name: guest.name, title: this.project(guest.projectId).title, slot: guest.slot, expiresAt: new Date(record.expiresAt).toISOString(), available: true };
  }
  join(token: unknown, name: unknown): GuestSession {
    const { record, guest } = this.invitation(token);
    const checkedName = string(name, 'nom', 100);
    record.used = true; this.store.put('guestInvitation', record);
    this.disconnectGuest(guest.id, true, false);
    guest.name = checkedName; guest.status = 'waiting'; guest.invitationExpiresAt = null;
    this.save(guest);
    const result = this.createSession('guest', guest.projectId, guest.id, record.owner);
    this.emit(); return result;
  }
  bridgeSession(projectId: string, deviceId: string): GuestSession {
    this.sweep(false); this.owner(deviceId); this.project(projectId);
    if (this.store.device(deviceId)?.kind !== 'pc') throw new ApiFailure(403, 'Le retour doit être démarré sur le PC de la salle.', 'LOCAL_BRIDGE_REQUIRED');
    if (this.bridge && this.bridge.projectId !== projectId) throw new ApiFailure(409, 'Un autre projet utilise déjà le retour de la salle.', 'BRIDGE_PROJECT_BUSY');
    if (this.bridge) this.drop(this.bridge, true);
    const result = this.createSession('bridge', projectId, null, deviceId);
    this.bridge = this.sessions.get(hashSecret(result.token))!;
    this.bridgeReady = false; this.bridgeError = null;
    this.emit(); return result;
  }
  stopBridge(projectId: string): void {
    if (this.bridge?.projectId === projectId) this.drop(this.bridge, true);
    this.emit();
  }
  sourceTicket(guestId: string, deviceId: string): { url: string; expiresAt: string } {
    this.sweep(false);
    this.owner(deviceId); this.getGuest(guestId);
    for (const [key, ticket] of this.sourceTickets) if (ticket.guestId === guestId) this.sourceTickets.delete(key);
    const token = randomBytes(32).toString('base64url'); const expiresAt = this.now() + SOURCE_MS;
    this.sourceTickets.set(hashSecret(token), { hash: hashSecret(token), guestId, owner: deviceId, expiresAt });
    return { url: `${this.localBase}/#guest-source/${token}`, expiresAt: new Date(expiresAt).toISOString() };
  }
  hasSourceAccess(guestId: string): boolean {
    this.sweep(false);
    return [...this.sourceTickets.values()].some(ticket => ticket.guestId === guestId)
      || [...this.sessions.values()].some(session => session.peer.role === 'source' && session.peer.guestId === guestId && session.socket?.readyState === 1);
  }
  claimSource(token: unknown): GuestSession {
    if (typeof token !== 'string' || !tokenPattern.test(token)) throw new ApiFailure(401, 'Source OBS invalide ou expirée.', 'SOURCE_REJECTED');
    const hash = hashSecret(token); const ticket = this.sourceTickets.get(hash);
    if (!ticket || ticket.expiresAt <= this.now()) throw new ApiFailure(401, 'Source OBS invalide, déjà utilisée ou expirée.', 'SOURCE_REJECTED');
    this.owner(ticket.owner); const guest = this.getGuest(ticket.guestId);
    this.sourceTickets.delete(hash);
    for (const session of [...this.sessions.values()]) if (session.peer.role === 'source' && session.peer.guestId === guest.id) this.drop(session, true);
    const result = this.createSession('source', guest.projectId, guest.id, ticket.owner);
    this.emit(); return result;
  }
  private createSession(role: GuestPeerRole, projectId: string, guestId: string | null, owner: string): GuestSession {
    if (this.closed) throw new ApiFailure(503, 'La passerelle invités est arrêtée.', 'GUEST_GATEWAY_CLOSED');
    const token = randomBytes(32).toString('base64url');
    const session: SessionRecord = { tokenHash: hashSecret(token), peer: { id: randomUUID(), role, guestId }, projectId, owner, expiresAt: this.now() + SESSION_MS, socket: null, alive: true };
    this.sessions.set(session.tokenHash, session);
    return this.result(session, token);
  }
  private ice(session: SessionRecord): GuestIceServer[] {
    const servers: GuestIceServer[] = this.stun.length ? [{ urls: this.stun }] : [];
    if (this.turn.length) {
      const username = `${Math.floor(session.expiresAt / 1000)}:${session.peer.id}`;
      servers.push({ urls: this.turn, username, credential: createHmac('sha1', this.config.turnSecret!).update(username).digest('base64') });
    }
    return servers;
  }
  private result(session: SessionRecord, token: string): GuestSession {
    const project = this.project(session.projectId);
    const base = session.peer.role === 'guest' ? this.publicBase : this.localBase;
    return { token, role: session.peer.role, peerId: session.peer.id, guestId: session.peer.guestId, projectId: session.projectId, roomTitle: project.title,
      name: session.peer.guestId ? this.getGuest(session.peer.guestId).name : 'Salle Nino', expiresAt: new Date(session.expiresAt).toISOString(), socketPath: `${base.replace(/^http/, 'ws')}/api/guest/events`, iceServers: this.ice(session), room: this.room(session.projectId) };
  }
  private authenticated(token: unknown): SessionRecord {
    if (typeof token !== 'string' || !tokenPattern.test(token)) throw new ApiFailure(401, 'Session invitée invalide.', 'GUEST_UNAUTHENTICATED');
    const session = this.sessions.get(hashSecret(token));
    if (!session || session.expiresAt <= this.now()) throw new ApiFailure(401, 'Session invitée expirée ou révoquée.', 'GUEST_UNAUTHENTICATED');
    this.owner(session.owner); this.project(session.projectId);
    if (session.peer.guestId) this.getGuest(session.peer.guestId);
    return session;
  }
  resume(token: unknown): GuestSession { const session = this.authenticated(token); return this.result(session, token as string); }
  admit(guestId: string): void {
    this.sweep(false);
    const guest = this.getGuest(guestId);
    if (!guest.joined || !guest.mediaReady || !this.bridgeReady || this.bridge?.projectId !== guest.projectId || this.bridge.socket?.readyState !== 1) {
      throw new ApiFailure(409, 'Attendez la connexion, le retour de la salle et la réception effective de l’image et du son.', 'GUEST_NOT_READY');
    }
    if (!guest.sourceReady) this.sourcePending.set(guest.id, this.now() + 15_000);
    guest.admitted = true; guest.muted = false; this.save(guest); this.emit();
  }
  setMuted(guestId: string, muted: boolean): void {
    this.sweep(false);
    if (typeof muted !== 'boolean') throw new ApiFailure(400, 'État du micro invalide.');
    const guest = this.getGuest(guestId);
    if (!muted && !guest.admitted) throw new ApiFailure(409, 'Admettez d’abord cet invité.', 'GUEST_NOT_ADMITTED');
    guest.muted = muted; this.save(guest); this.emit();
  }
  remove(guestId: string): void {
    const guest = this.getGuest(guestId); this.disconnectGuest(guestId, true);
    const invitation = this.store.get<InvitationRecord>('guestInvitation', guestId);
    if (invitation) { invitation.used = true; this.store.put('guestInvitation', invitation); }
    guest.status = 'removed'; guest.joined = guest.mediaReady = guest.sourceReady = guest.admitted = false; guest.muted = true; guest.invitationExpiresAt = null;
    this.store.put('guest', guest); this.emit();
  }
  revokeDevice(deviceId: string): void {
    for (const session of [...this.sessions.values()]) if (session.owner === deviceId) this.drop(session, true);
    for (const [key, ticket] of this.sourceTickets) if (ticket.owner === deviceId) this.sourceTickets.delete(key);
    this.emit();
  }
  private disconnectGuest(guestId: string, revoke: boolean, includeSources = true): void {
    for (const session of [...this.sessions.values()]) if (session.peer.guestId === guestId && (includeSources || session.peer.role === 'guest')) this.drop(session, revoke);
    if (includeSources) for (const [key, ticket] of this.sourceTickets) if (ticket.guestId === guestId) this.sourceTickets.delete(key);
  }
  private drop(session: SessionRecord, revoke: boolean): void {
    const socket = session.socket; session.socket = null;
    if (revoke) this.sessions.delete(session.tokenHash);
    if (socket && socket.readyState < 2) socket.close(4001, 'Session interrompue ou révoquée');
    if (session.peer.role === 'bridge' && this.bridge === session) {
      this.bridgeReady = false; this.bridgeError = 'Le retour de la salle est déconnecté.';
      if (revoke) this.bridge = null;
      for (const guest of this.store.list<GuestSlot>('guest').filter(guest => guest.projectId === session.projectId)) {
        this.sourcePending.delete(guest.id);
        guest.mediaReady = guest.sourceReady = guest.admitted = false; guest.muted = true; this.save(guest);
      }
    } else if (session.peer.guestId) {
      const guest = this.store.get<GuestSlot>('guest', session.peer.guestId);
      if (guest) {
        this.sourcePending.delete(guest.id);
        if (session.peer.role === 'guest') guest.joined = guest.mediaReady = guest.sourceReady = false;
        if (session.peer.role === 'source') guest.sourceReady = false;
        guest.admitted = false; guest.muted = true; this.save(guest);
      }
    }
  }
  private linked(a: SessionRecord, b: SessionRecord): boolean {
    return a !== b && a.projectId === b.projectId && (a.peer.role === 'bridge' ? b.peer.role !== 'bridge' : b.peer.role === 'bridge');
  }
  private peers(session: SessionRecord): GuestPeer[] {
    return [...this.sessions.values()].filter(peer => peer.socket?.readyState === 1 && this.linked(session, peer)).map(peer => peer.peer);
  }
  private sweep(heartbeat: boolean): void {
    let changed = false;
    for (const [id, deadline] of this.sourcePending) if (deadline <= this.now()) {
      this.sourcePending.delete(id);
      const guest = this.store.get<GuestSlot>('guest', id);
      if (guest?.admitted && !guest.sourceReady) {
        guest.admitted = false; guest.muted = true;
        guest.error = 'OBS n’a pas reçu l’image et le son. Vérifiez les sources puis accueillez à nouveau l’invité.';
        this.save(guest); changed = true;
      }
    }
    for (const session of [...this.sessions.values()]) {
      if (session.expiresAt <= this.now() || !this.store.device(session.owner) || !this.store.get<Project>('project', session.projectId) || this.store.get<Project>('project', session.projectId)?.status === 'archived') {
        this.drop(session, true); changed = true;
      } else if (heartbeat && session.socket) {
        if (!session.alive) { this.drop(session, false); changed = true; }
        else { session.alive = false; session.socket.ping(); }
      }
    }
    for (const [key, ticket] of this.sourceTickets) if (ticket.expiresAt <= this.now() || !this.store.device(ticket.owner)) this.sourceTickets.delete(key);
    if (changed) this.emit();
  }
  /** First-frame auth avoids credentials in URLs, proxy logs and WebSocket protocols. */
  attachSocket(socket: WebSocket, options: { allowSource?: boolean; allowBridge?: boolean } = {}): void {
    let session: SessionRecord | null = null;
    const bucket: Bucket = { start: this.now(), count: 0 };
    const authTimer = setTimeout(() => socket.close(4001, 'Authentification requise'), 10_000);
    authTimer.unref();
    const fail = (error: unknown): void => {
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'error', error: error instanceof ApiFailure ? error.message : 'Message invité invalide.' } satisfies GuestServerMessage));
      socket.close(4003, 'Message ou accès non autorisé');
    };
    socket.on('pong', () => { if (session) session.alive = true; });
    socket.on('message', (raw, isBinary) => {
      try {
        if (isBinary || raw.toString().length > 64 * 1024) throw new ApiFailure(400, 'Message trop volumineux.');
        if (this.now() - bucket.start >= 10_000) { bucket.start = this.now(); bucket.count = 0; }
        if (++bucket.count > 300) throw new ApiFailure(429, 'Trop de messages de signalisation.');
        const data = object(JSON.parse(raw.toString()));
        if (!session) {
          if (data.type !== 'auth' || Object.keys(data).some(key => !['type', 'token'].includes(key))) throw new ApiFailure(401, 'Authentification requise.');
          session = this.authenticated(data.token);
          if (session.peer.role === 'source' && options.allowSource === false) throw new ApiFailure(403, 'La source OBS est réservée au PC de la salle.', 'LOCAL_SOURCE_ONLY');
          if (session.peer.role === 'bridge' && options.allowBridge === false) throw new ApiFailure(403, 'Le retour de la salle est réservé au PC.', 'LOCAL_BRIDGE_ONLY');
          if (session.socket?.readyState === 1) throw new ApiFailure(409, 'Cette session est déjà connectée.');
          session.socket = socket; session.alive = true;
          clearTimeout(authTimer);
          if (session.peer.role === 'guest') { const guest = this.getGuest(session.peer.guestId!); guest.joined = true; guest.status = 'waiting'; this.save(guest); }
          this.send(session, { type: 'welcome', peer: session.peer, peers: this.peers(session), room: this.room(session.projectId) });
          this.emit(); return;
        }
        this.authenticatedByRecord(session);
        this.message(session, data);
      } catch (error) { fail(error); }
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      if (session?.socket === socket) { this.drop(session, false); this.emit(); }
    });
    socket.on('error', () => { if (session?.socket === socket) { this.drop(session, false); this.emit(); } });
  }
  private authenticatedByRecord(session: SessionRecord): void {
    if (!this.sessions.has(session.tokenHash) || session.expiresAt <= this.now()) throw new ApiFailure(401, 'Session expirée ou révoquée.');
    this.owner(session.owner); this.project(session.projectId);
    if (session.peer.guestId) this.getGuest(session.peer.guestId);
  }
  private message(session: SessionRecord, data: Record<string, unknown>): void {
    if (data.type === 'leave') { this.drop(session, true); this.emit(); return; }
    if (data.type === 'signal') {
      if (Object.keys(data).some(key => !['type', 'to', 'description', 'candidate'].includes(key))) throw new ApiFailure(400, 'Signal invalide.');
      const to = string(data.to, 'destinataire', 100);
      const peer = [...this.sessions.values()].find(candidate => candidate.peer.id === to);
      if (!peer || peer.socket?.readyState !== 1 || !this.linked(session, peer)) throw new ApiFailure(403, 'Ce destinataire n’est pas autorisé.', 'GUEST_PEER_FORBIDDEN');
      this.authenticatedByRecord(peer);
      const result: Extract<GuestServerMessage, { type: 'signal' }> = { type: 'signal', from: session.peer };
      if (data.description !== undefined) {
        const description = object(data.description);
        if (!['offer', 'answer'].includes(String(description.type)) || Object.keys(description).some(key => !['type', 'sdp'].includes(key))) throw new ApiFailure(400, 'Description WebRTC invalide.');
        // SDP requires its final CRLF. Generic text trimming corrupts valid
        // offers/answers, so validate the bounds without rewriting the payload.
        if (typeof description.sdp !== 'string' || !description.sdp.trim() || description.sdp.length > 48 * 1024 || description.sdp.includes('\0')) throw new ApiFailure(400, 'Description WebRTC invalide.');
        result.description = { type: description.type as 'offer' | 'answer', sdp: description.sdp };
      }
      if ('candidate' in data) {
        if (data.candidate === null) result.candidate = null;
        else {
          const candidate = object(data.candidate);
          if (Object.keys(candidate).some(key => !['candidate', 'sdpMid', 'sdpMLineIndex'].includes(key))) throw new ApiFailure(400, 'Candidat WebRTC invalide.');
          const sdpMid = candidate.sdpMid === undefined || candidate.sdpMid === null ? candidate.sdpMid : string(candidate.sdpMid, 'sdpMid', 100, true);
          const line = candidate.sdpMLineIndex;
          if (line !== undefined && line !== null && (!Number.isInteger(line) || (line as number) < 0 || (line as number) > 100)) throw new ApiFailure(400, 'Index WebRTC invalide.');
          result.candidate = { candidate: string(candidate.candidate, 'candidat WebRTC', 4000, true), sdpMid: sdpMid as string | null | undefined, sdpMLineIndex: line as number | null | undefined };
        }
      }
      if (!result.description && !('candidate' in result)) throw new ApiFailure(400, 'Signal vide.');
      this.send(peer, result); return;
    }
    if (data.type === 'media') {
      const previous = JSON.stringify(this.room(session.projectId));
      if (Object.keys(data).some(key => !['type', 'ready', 'guestId', 'video', 'audio', 'error'].includes(key)) || typeof data.ready !== 'boolean'
        || (data.video !== undefined && typeof data.video !== 'boolean') || (data.audio !== undefined && typeof data.audio !== 'boolean')) throw new ApiFailure(400, 'État média invalide.');
      const error = data.error === undefined ? null : string(data.error, 'erreur média', 300, true);
      if (session.peer.role === 'guest') throw new ApiFailure(403, 'Seule la réception dans la salle confirme le média.', 'GUEST_MEDIA_FORBIDDEN');
      if (session.peer.role === 'bridge' && data.guestId === undefined) {
        this.bridgeReady = data.ready && data.video === true && data.audio === true;
        this.bridgeError = this.bridgeReady ? null : error || 'Le retour vidéo et audio de la salle n’est pas prêt.';
        for (const guest of this.store.list<GuestSlot>('guest').filter(guest => guest.projectId === session.projectId)) {
          if (!this.bridgeReady) { guest.admitted = false; guest.muted = true; }
          this.save(guest);
        }
      } else {
        const guestId = string(data.guestId, 'invité', 100);
        const guest = this.getGuest(guestId);
        if (guest.projectId !== session.projectId || (session.peer.role === 'source' && session.peer.guestId !== guest.id)) throw new ApiFailure(403, 'Cet invité n’est pas autorisé.', 'GUEST_MEDIA_FORBIDDEN');
        const ready = data.ready && data.video === true && data.audio === true && guest.joined;
        const wasSourceReady = guest.sourceReady;
        if (session.peer.role === 'source') guest.sourceReady = ready;
        else guest.mediaReady = ready;
        guest.error = ready ? null : error || 'Image et son en attente.';
        if (ready && session.peer.role === 'source') this.sourcePending.delete(guest.id);
        if (!ready && (session.peer.role !== 'source' || wasSourceReady || !this.sourcePending.has(guest.id))) {
          this.sourcePending.delete(guest.id);
          guest.admitted = false; guest.muted = true;
        }
        this.save(guest);
      }
      if (JSON.stringify(this.room(session.projectId)) !== previous) this.emit();
      return;
    }
    throw new ApiFailure(400, 'Message invité non reconnu.');
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer);
    for (const session of [...this.sessions.values()]) this.drop(session, true);
    this.sourceTickets.clear(); this.sourcePending.clear(); this.listeners.clear();
  }
}
