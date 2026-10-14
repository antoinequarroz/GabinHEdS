import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { startStunFixture } from './stun-fixture.js';

test('loopback STUN Binding reports the actual sender port and address with the original transaction', { timeout: 4000 }, async () => {
  const stun = await startStunFixture(); const client = createSocket('udp4');
  try {
    await new Promise<void>(resolve => client.bind(0, '127.0.0.1', resolve));
    const request = Buffer.alloc(20); request.writeUInt16BE(0x0001); request.writeUInt32BE(0x2112a442, 4); randomBytes(12).copy(request, 8);
    const response = new Promise<Buffer>(resolve => client.once('message', resolve)); client.send(request, stun.port, '127.0.0.1');
    const result = await response;
    assert.equal(result.readUInt16BE(0), 0x0101); assert.equal(result.readUInt16BE(2), 12);
    assert.deepEqual(result.subarray(8, 20), request.subarray(8, 20));
    assert.equal(result.readUInt16BE(20), 0x0020); assert.equal(result[25], 0x01);
    assert.equal(result.readUInt16BE(26) ^ 0x2112, client.address().port);
    assert.deepEqual([...result.subarray(28)].map((part, index) => part ^ [0x21, 0x12, 0xa4, 0x42][index]), [127, 0, 0, 1]);
    assert.equal(stun.count(), 1);
  } finally { client.close(); await stun.close(); }
});
