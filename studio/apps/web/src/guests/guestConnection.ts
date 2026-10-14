import type { GuestPeer, GuestRoomState, GuestSession, GuestServerMessage, GuestClientMessage } from '@gabin/shared';
import { MixMinus } from './mixMinus';
import { validSession } from './guestApi';

interface Link { peer: GuestPeer; pc: RTCPeerConnection; video: RTCRtpTransceiver | null; audio: RTCRtpTransceiver | null; stream: MediaStream; candidates: RTCIceCandidateInit[]; makingOffer: boolean; changed: boolean; audioBytes: number; audioAt: number; videoFrames: number; outboundFrames: number; outboundAt: number; programStartedAt: number; ready: boolean; }
export interface ConnectionHooks {
  room: (room: GuestRoomState) => void;
  stream: (peer: GuestPeer, stream: MediaStream | null) => void;
  status: (message: string, connected: boolean) => void;
  error: (message: string) => void;
}

/** The bridge is the sole offerer: reconnects cannot create competing SDP offers. */
export class GuestConnection {
  private socket: WebSocket | null = null;
  private links = new Map<string, Link>();
  private peers: GuestPeer[] = [];
  private room: GuestRoomState;
  private timer: ReturnType<typeof setInterval> | undefined;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private localReady = false;
  private operation = Promise.resolve();
  private observedRoom = '';
  readonly mix: MixMinus | null;

  constructor(readonly session: GuestSession, readonly local: MediaStream | null, private hooks: ConnectionHooks) {
    validSession(session); this.room = session.room;
    this.mix = session.role === 'bridge' ? new MixMinus() : null;
    if (this.mix && local?.getAudioTracks().length) this.mix.setRoom(local);
    this.mix?.update(this.room);
  }
  async start(): Promise<void> {
    if (this.closed) return; await this.mix?.resume(); if (this.closed) return; this.connect();
    this.timer = setInterval(() => { void this.checkMedia().catch(error => { if (!this.closed) this.hooks.error(error instanceof Error ? error.message : 'La vérification vidéo a échoué.'); }); }, 2000);
  }
  setLocalReady(ready: boolean): void { this.localReady = ready; }
  monitor(enabled: boolean): void { if (this.closed) return; this.mix?.setMonitor(enabled); void this.mix?.resume().catch(error => this.hooks.error(error instanceof Error ? error.message : 'L’écoute des invités n’a pas pu démarrer.')); }
  private send(message: GuestClientMessage): void { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }
  private connect(): void {
    if (this.closed) return;
    const socket = new WebSocket(new URL(this.session.socketPath, location.origin).href); this.socket = socket;
    socket.onopen = () => this.send({ type: 'auth', token: this.session.token });
    socket.onmessage = event => {
      this.operation = this.operation.then(async () => {
        if (this.socket !== socket || this.closed) return;
        const message = JSON.parse(String(event.data)) as GuestServerMessage;
        if (message.type === 'welcome' || message.type === 'room') {
          this.room = message.room; this.peers = message.peers; this.mix?.update(this.room); this.hooks.room(this.room);
          if (message.type === 'welcome') this.hooks.status('Connexion au studio établie. Vérification des médias…', true);
          await this.syncPeers();
        } else if (message.type === 'signal') await this.signal(message);
        else if (message.type === 'error') this.hooks.error(message.error);
      }).catch(error => this.hooks.error(error instanceof Error ? error.message : 'La connexion vidéo a été interrompue.'));
    };
    socket.onclose = event => {
      if (this.socket !== socket || this.closed) return;
      this.socket = null; this.clearLinks(); this.hooks.status('Connexion interrompue. Reconnexion…', false);
      if (event.code === 4001 || event.code === 4003) { this.hooks.error('Ce lien est expiré ou l’accès a été retiré. Demandez une nouvelle invitation.'); void this.close(); return; }
      this.reconnect = setTimeout(() => this.connect(), 2000);
    };
    socket.onerror = () => this.hooks.status('Le studio ne répond pas. Vérifiez votre connexion.', false);
  }
  private async syncPeers(): Promise<void> {
    const available = this.peers.filter(peer => peer.id !== this.session.peerId && (this.session.role === 'bridge' ? peer.role !== 'bridge' : peer.role === 'bridge'));
    for (const [id, link] of this.links) if (!available.some(peer => peer.id === id)) this.removeLink(link);
    if (this.session.role !== 'bridge') return;
    for (const peer of available) {
      const link = this.links.get(peer.id) ?? this.createLink(peer);
      await this.updateTracks(link);
      if (!link.pc.localDescription) await this.offer(link);
    }
  }
  private createLink(peer: GuestPeer): Link {
    const pc = new RTCPeerConnection({ iceServers: this.session.iceServers });
    // Answerers must use the m-lines received in the offer. Creating their own
    // transceivers first can leave tracks on an additional, unnegotiated pair.
    const direction = peer.role === 'source' ? 'sendonly' : 'sendrecv';
    const video = this.session.role === 'bridge' ? pc.addTransceiver('video', { direction }) : null;
    const audio = this.session.role === 'bridge' ? pc.addTransceiver('audio', { direction }) : null;
    const link: Link = { peer, pc, video, audio, stream: new MediaStream(), candidates: [], makingOffer: false, changed: false, audioBytes: 0, audioAt: 0, videoFrames: 0, outboundFrames: 0, outboundAt: 0, programStartedAt: 0, ready: false };
    this.links.set(peer.id, link);
    pc.onicecandidate = event => this.send({ type: 'signal', to: peer.id, candidate: event.candidate ? { candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid, sdpMLineIndex: event.candidate.sdpMLineIndex } : null });
    pc.ontrack = event => {
      if (!link.stream.getTracks().some(track => track.id === event.track.id)) link.stream.addTrack(event.track);
      event.track.onended = () => { link.ready = false; this.hooks.stream(peer, null); this.report(); };
      if (this.mix && peer.role === 'guest' && peer.guestId && link.stream.getAudioTracks().length) this.mix.setRemote(peer.guestId, link.stream);
      this.hooks.stream(peer, link.stream);
      if (this.session.role === 'bridge') { void this.syncPeers().catch(error => { if (!this.closed) this.hooks.error(error instanceof Error ? error.message : 'La liaison vidéo a échoué.'); }); }
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) { link.ready = false; this.hooks.stream(peer, null); this.report(); }
      if (pc.connectionState === 'failed' && this.session.role === 'bridge' && !this.closed) { pc.restartIce(); void this.offer(link).catch(error => { if (!this.closed) this.hooks.error(error instanceof Error ? error.message : 'La reconnexion vidéo a échoué.'); }); }
    };
    pc.onnegotiationneeded = () => { if (this.session.role === 'bridge' && pc.localDescription) void this.offer(link).catch(error => { if (!this.closed) this.hooks.error(error instanceof Error ? error.message : 'La liaison vidéo a échoué.'); }); };
    return link;
  }
  private async updateTracks(link: Link): Promise<void> {
    if (!link.video || !link.audio) return;
    let video: MediaStreamTrack | null = null; let audio: MediaStreamTrack | null = null;
    if (this.session.role === 'bridge' && link.peer.guestId && this.mix) {
      const guest = this.room.guests.find(item => item.id === link.peer.guestId);
      if (link.peer.role === 'guest') {
        video = guest?.admitted && guest.joined ? this.local?.getVideoTracks()[0] ?? null : null;
        audio = this.mix.returnTrack(link.peer.guestId);
      } else if (link.peer.role === 'source') {
        const remote = [...this.links.values()].find(item => item.peer.role === 'guest' && item.peer.guestId === link.peer.guestId);
        video = guest?.admitted && guest.joined ? remote?.stream.getVideoTracks().find(track => track.readyState === 'live') ?? null : null;
        audio = this.mix.sourceTrack(link.peer.guestId);
      }
    } else if (this.session.role === 'guest') {
      video = this.local?.getVideoTracks()[0] ?? null; audio = this.local?.getAudioTracks()[0] ?? null;
    }
    if (link.video.sender.track !== video) {
      await link.video.sender.replaceTrack(video);
      if (this.session.role === 'bridge' && link.peer.role === 'guest') {
        link.programStartedAt = video ? performance.now() : 0;
        link.outboundFrames = 0; link.outboundAt = 0;
      }
    }
    if (link.audio.sender.track !== audio) await link.audio.sender.replaceTrack(audio);
  }
  private async offer(link: Link): Promise<void> {
    if (link.makingOffer || link.pc.signalingState !== 'stable' || this.closed) { link.changed = true; return; }
    link.makingOffer = true; link.changed = false;
    try {
      await this.updateTracks(link); await link.pc.setLocalDescription(await link.pc.createOffer());
      this.send({ type: 'signal', to: link.peer.id, description: { type: 'offer', sdp: link.pc.localDescription!.sdp } });
    } finally { link.makingOffer = false; }
  }
  private async signal(message: Extract<GuestServerMessage, { type: 'signal' }>): Promise<void> {
    let link = this.links.get(message.from.id);
    if (!link) {
      if (this.session.role === 'bridge' || message.from.role !== 'bridge') return;
      link = this.createLink(message.from);
    }
    if (message.description) {
      if (this.session.role === 'bridge' && message.description.type !== 'answer') return;
      if (this.session.role !== 'bridge' && message.description.type !== 'offer') return;
      await link.pc.setRemoteDescription(message.description);
      // Remote SDP transceivers, not separately created m-lines, define the answer's senders.
      if (this.session.role !== 'bridge') {
        const transceivers = link.pc.getTransceivers();
        link.video = transceivers.find(item => item.mid !== null && item.receiver.track.kind === 'video') ?? null;
        link.audio = transceivers.find(item => item.mid !== null && item.receiver.track.kind === 'audio') ?? null;
        if (!link.video || !link.audio) throw new Error('Le studio n’a pas pu établir les pistes caméra et micro. Reconnectez l’appel.');
        link.video.direction = this.session.role === 'guest' ? 'sendrecv' : 'recvonly';
        link.audio.direction = this.session.role === 'guest' ? 'sendrecv' : 'recvonly';
      }
      for (const candidate of link.candidates.splice(0)) await link.pc.addIceCandidate(candidate);
      if (message.description.type === 'offer') {
        await this.updateTracks(link); await link.pc.setLocalDescription(await link.pc.createAnswer());
        this.send({ type: 'signal', to: message.from.id, description: { type: 'answer', sdp: link.pc.localDescription!.sdp } });
      } else if (link.changed) await this.offer(link);
    } else if (message.candidate) {
      if (link.pc.remoteDescription) await link.pc.addIceCandidate(message.candidate);
      else link.candidates.push(message.candidate);
    }
  }
  private async checkMedia(): Promise<void> {
    for (const link of this.links.values()) {
      if (link.pc.connectionState !== 'connected') { if (link.ready) this.hooks.stream(link.peer, null); link.ready = false; continue; }
      const stats = await link.pc.getStats(); let audioBytes = 0; let videoFrames = 0; let outboundFrames = 0;
      stats.forEach(stat => {
        if (stat.type === 'outbound-rtp' && (stat.kind ?? stat.mediaType) === 'video') outboundFrames += Number(stat.framesEncoded ?? 0);
        if (stat.type !== 'inbound-rtp') return;
        if ((stat.kind ?? stat.mediaType) === 'audio') audioBytes += Number(stat.bytesReceived ?? 0);
        if ((stat.kind ?? stat.mediaType) === 'video') videoFrames += Number(stat.framesDecoded ?? 0);
      });
      if (outboundFrames > link.outboundFrames) link.outboundAt = performance.now();
      link.outboundFrames = outboundFrames;
      if (audioBytes > link.audioBytes) link.audioAt = performance.now();
      const ready = audioBytes > 0 && performance.now() - link.audioAt < 6000 && videoFrames > link.videoFrames;
      if (ready !== link.ready) this.hooks.stream(link.peer, ready ? link.stream : null);
      link.ready = ready;
      link.audioBytes = audioBytes; link.videoFrames = videoFrames;
    }
    this.report();
  }
  private report(): void {
    const activeProgramLinks = [...this.links.values()].filter(link => link.peer.role === 'guest' && link.programStartedAt > 0);
    // In the waiting room no program is sent. Once admitted, actual encoded
    // outbound frames prove capture continues even when the operator uses Nino
    // in another window and the preview's compositor stops presenting frames.
    const programFresh = activeProgramLinks.every(link => link.outboundAt > 0
      ? performance.now() - link.outboundAt < 5000 : performance.now() - link.programStartedAt < 8000);
    const captureReady = this.localReady && !!this.local?.getTracks().every(track => track.readyState === 'live' && !track.muted)
      && this.mix?.context.state === 'running' && programFresh;
    if (this.session.role === 'bridge') {
      this.send({ type: 'media', ready: captureReady, audio: captureReady, video: captureReady });
      for (const link of this.links.values()) if (link.peer.role === 'guest' && link.peer.guestId) this.send({ type: 'media', guestId: link.peer.guestId, ready: link.ready, audio: link.ready, video: link.ready });
    } else if (this.session.role === 'source') {
      // Source visibility is controlled by OBS. Reception and successful media
      // playback, rather than a visible preview element, establish readiness.
      const ready = this.localReady && [...this.links.values()].some(link => link.ready);
      this.send({ type: 'media', guestId: this.session.guestId ?? undefined, ready, audio: ready, video: ready });
    }
    const key = JSON.stringify(this.room);
    if (key !== this.observedRoom) { this.observedRoom = key; this.hooks.room(this.room); }
  }
  private removeLink(link: Link): void {
    link.pc.ontrack = null; link.pc.onconnectionstatechange = null; link.pc.onnegotiationneeded = null;
    link.pc.close(); this.links.delete(link.peer.id); this.hooks.stream(link.peer, null);
    link.stream.getTracks().forEach(track => track.stop());
    if (link.peer.role === 'guest' && link.peer.guestId) this.mix?.removeRemote(link.peer.guestId);
  }
  private clearLinks(): void { for (const link of [...this.links.values()]) this.removeLink(link); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer); clearTimeout(this.reconnect); this.send({ type: 'leave' });
    this.socket?.close(); this.socket = null; this.clearLinks(); this.local?.getTracks().forEach(track => track.stop()); await this.mix?.close();
    this.hooks.status('Appel terminé. Caméra et micro arrêtés.', false);
  }
}
