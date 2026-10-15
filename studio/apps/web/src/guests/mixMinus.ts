import type { GuestRoomState } from '@gabin/shared';

/** Each caller has a separate bus. A caller's own microphone has no path to its return. */
export class MixMinus {
  readonly context = new AudioContext();
  private room: MediaStreamAudioSourceNode | null = null;
  private remotes = new Map<string, MediaStreamAudioSourceNode>();
  private returns = new Map<string, { output: MediaStreamAudioDestinationNode; gains: Map<string, GainNode> }>();
  private sources = new Map<string, { output: MediaStreamAudioDestinationNode; gain: GainNode }>();
  private monitor = this.context.createGain();
  private monitorGains = new Map<string, GainNode>();
  private monitorEnabled = false;
  private state: GuestRoomState | null = null;

  constructor() { this.monitor.gain.value = 0; this.monitor.connect(this.context.destination); }
  async resume(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.context.resume(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Autorisez le son dans ce navigateur puis reconnectez la liaison.')), 5000); })]); }
    finally { clearTimeout(timer); }
  }
  setRoom(stream: MediaStream): void {
    this.room?.disconnect();
    this.room = this.context.createMediaStreamSource(stream);
    for (const bus of this.returns.values()) { bus.gains.get('room')?.disconnect(); const gain = this.context.createGain(); this.room.connect(gain); gain.connect(bus.output); bus.gains.set('room', gain); }
    this.applyState();
  }
  setRemote(id: string, stream: MediaStream): void {
    this.removeRemote(id);
    if (!stream.getAudioTracks().length) return;
    const node = this.context.createMediaStreamSource(stream);
    this.remotes.set(id, node);
    for (const [caller, bus] of this.returns) {
      if (caller === id) continue;
      const gain = this.context.createGain(); node.connect(gain); gain.connect(bus.output); bus.gains.set(id, gain);
    }
    const source = this.sources.get(id);
    if (source) node.connect(source.gain);
    const monitorGain = this.context.createGain(); node.connect(monitorGain); monitorGain.connect(this.monitor); this.monitorGains.set(id, monitorGain);
    this.applyState();
  }
  removeRemote(id: string): void {
    this.remotes.get(id)?.disconnect(); this.remotes.delete(id);
    this.monitorGains.get(id)?.disconnect(); this.monitorGains.delete(id);
    for (const bus of this.returns.values()) { bus.gains.get(id)?.disconnect(); bus.gains.delete(id); }
  }
  returnTrack(caller: string): MediaStreamTrack {
    let bus = this.returns.get(caller);
    if (!bus) {
      bus = { output: this.context.createMediaStreamDestination(), gains: new Map() };
      this.returns.set(caller, bus);
      if (this.room) { const gain = this.context.createGain(); this.room.connect(gain); gain.connect(bus.output); bus.gains.set('room', gain); }
      for (const [id, node] of this.remotes) {
        if (id === caller) continue;
        const gain = this.context.createGain(); node.connect(gain); gain.connect(bus.output); bus.gains.set(id, gain);
      }
    }
    this.applyState();
    return bus.output.stream.getAudioTracks()[0]!;
  }
  sourceTrack(id: string): MediaStreamTrack {
    let bus = this.sources.get(id);
    if (!bus) {
      const gain = this.context.createGain(); const output = this.context.createMediaStreamDestination();
      gain.connect(output); bus = { gain, output }; this.sources.set(id, bus); this.remotes.get(id)?.connect(gain);
    }
    this.applyState();
    return bus.output.stream.getAudioTracks()[0]!;
  }
  update(state: GuestRoomState): void { this.state = state; this.applyState(); }
  setMonitor(enabled: boolean): void { this.monitorEnabled = enabled; this.applyState(); }
  private applyState(): void {
    const audible = (id: string) => this.state?.guests.some(guest => guest.id === id && guest.admitted && !guest.muted && guest.joined) ?? false;
    for (const [caller, bus] of this.returns) {
      const admitted = this.state?.guests.some(guest => guest.id === caller && guest.admitted && guest.joined) ?? false;
      for (const [id, gain] of bus.gains) gain.gain.value = admitted && (id === 'room' || audible(id)) ? 1 : 0;
    }
    for (const [id, bus] of this.sources) bus.gain.gain.value = audible(id) ? 1 : 0;
    // Monitoring uses its own per-guest gains, never the room microphone.
    this.monitor.gain.value = this.monitorEnabled ? 1 : 0;
    for (const [id, gain] of this.monitorGains) gain.gain.value = audible(id) ? 1 : 0;
  }
  async close(): Promise<void> {
    this.room?.disconnect(); for (const node of this.remotes.values()) node.disconnect();
    for (const bus of this.returns.values()) { bus.output.stream.getTracks().forEach(track => track.stop()); for (const gain of bus.gains.values()) gain.disconnect(); }
    for (const bus of this.sources.values()) { bus.output.stream.getTracks().forEach(track => track.stop()); bus.gain.disconnect(); }
    this.monitor.disconnect(); if (this.context.state !== 'closed') await this.context.close();
  }
}
