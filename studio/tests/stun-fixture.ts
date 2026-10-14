import { createSocket } from 'node:dgram';

/** Loopback-only RFC 8489 Binding responder for actual browser ICE tests.
 * Sections 5 and 14.2: https://www.rfc-editor.org/rfc/rfc8489.html
 * It reports the real UDP source address; it never changes or mocks RTC ICE. */
export async function startStunFixture() {
  const socket = createSocket('udp4'); let requests = 0;
  socket.on('message', (message, peer) => {
    if (peer.address !== '127.0.0.1' || message.length < 20 || message.length > 4096
      || message.readUInt16BE(0) !== 0x0001 || message.readUInt32BE(4) !== 0x2112a442
      || message.readUInt16BE(2) + 20 !== message.length || message.readUInt16BE(2) % 4) return;
    requests++;
    const response = Buffer.alloc(32);
    response.writeUInt16BE(0x0101, 0); response.writeUInt16BE(12, 2);
    response.writeUInt32BE(0x2112a442, 4); message.copy(response, 8, 8, 20);
    response.writeUInt16BE(0x0020, 20); response.writeUInt16BE(8, 22);
    response[25] = 0x01; response.writeUInt16BE(peer.port ^ 0x2112, 26);
    const cookie = [0x21, 0x12, 0xa4, 0x42];
    peer.address.split('.').forEach((part, index) => { response[28 + index] = Number(part) ^ cookie[index]; });
    socket.send(response, peer.port, peer.address);
  });
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', () => { socket.removeListener('error', reject); resolve(); }); });
  const address = socket.address();
  return { url: `stun:127.0.0.1:${address.port}`, port: address.port, count: () => requests,
    close: () => new Promise<void>(resolve => socket.close(resolve)) };
}
