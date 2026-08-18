// Covers the RESP commands and parser paths not exercised by server.test.ts.
import { expect, test } from 'vitest';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RespParser, startServer } from '../src/server.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-srv2-'));
}

function encode(...args: string[]) {
  let s = `*${args.length}\r\n`;
  for (const a of args) {
    const b = Buffer.from(a);
    s += `$${b.length}\r\n${a}\r\n`;
  }
  return s;
}

function encodeBuffers(...args: Buffer[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    parts.push(Buffer.from(`$${arg.length}\r\n`), arg, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

function parseChunks(parser: RespParser, chunks: readonly Buffer[]) {
  const results = [];
  for (const chunk of chunks) {
    for (const result of parser.feed(chunk)) results.push(result);
  }
  return results;
}

function splitAt(data: Buffer, offsets: readonly number[]): Buffer[] {
  const cuts = [0, ...offsets.filter((offset) => offset > 0 && offset < data.length), data.length]
    .toSorted((a, b) => a - b)
    .filter((offset, index, all) => index === 0 || offset !== all[index - 1]);
  const chunks: Buffer[] = [];
  for (let i = 1; i < cuts.length; i++) chunks.push(data.subarray(cuts[i - 1]!, cuts[i]!));
  return chunks;
}

function splitCrlfPairs(data: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  let cursor = 0;
  while (cursor < data.length) {
    const index = data.indexOf(Buffer.from('\r\n'), cursor);
    if (index === -1) break;
    if (index > cursor) chunks.push(data.subarray(cursor, index));
    chunks.push(data.subarray(index, index + 1), data.subarray(index + 1, index + 2));
    cursor = index + 2;
  }
  if (cursor < data.length) chunks.push(data.subarray(cursor));
  return chunks;
}

function makeOversizedPipeline() {
  const maxBuf = 32;
  const payload = Buffer.from('payload-*1\r\n$4\r\nPING\r\n-with-crlf');
  const frame = encodeBuffers(Buffer.from('ECHO'), payload);
  const nextCommand = Buffer.from(encode('PING'));
  return {
    maxBuf,
    payload,
    frame,
    stream: Buffer.concat([frame, nextCommand]),
    expected: [
      { type: 'error', message: `RESP request too large (>${maxBuf} bytes)` },
      { type: 'command', args: [Buffer.from('PING')] },
    ],
  };
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

function send(sock: net.Socket, cmd: string | Buffer): Promise<string> {
  return new Promise((resolve) => {
    sock.once('data', (d) => resolve(d.toString()));
    sock.write(cmd);
  });
}

function collectBytes(sock: net.Socket, expectedLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${expectedLength} reply bytes; got ${total}`));
    }, 20_000);
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= expectedLength) {
        cleanup();
        resolve(Buffer.concat(chunks, total));
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      sock.off('data', onData);
      sock.off('error', onError);
    };
    sock.on('data', onData);
    sock.once('error', onError);
  });
}

// Send a command and resolve when the server closes the connection (QUIT).
function sendUntilClose(sock: net.Socket, cmd: string | Buffer): Promise<void> {
  return new Promise((resolve) => {
    sock.once('close', () => resolve());
    sock.write(cmd);
  });
}

function sendAndCollectUntilClose(sock: net.Socket, cmd: string | Buffer): Promise<string> {
  return new Promise((resolve) => {
    let response = '';
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      response += chunk.toString();
    });
    sock.once('close', () => resolve(response));
    sock.write(cmd);
  });
}

test('RESP: ECHO and PING with argument', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    assert.equal(await send(sock, encode('ECHO', 'hello')), '$5\r\nhello\r\n');
    assert.equal(await send(sock, encode('PING', 'hi')), '$2\r\nhi\r\n');
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP: EXISTS / MSET / MGET / TTL', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    assert.equal(await send(sock, encode('MSET', 'a', '1', 'b', '2')), '+OK\r\n');
    assert.equal(await send(sock, encode('EXISTS', 'a')), ':1\r\n');
    assert.equal(await send(sock, encode('EXISTS', 'z')), ':0\r\n');
    assert.equal(await send(sock, encode('MGET', 'a', 'b')), '*2\r\n$1\r\n1\r\n$1\r\n2\r\n');
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP: SET with EX / PX sets a TTL', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    assert.equal(await send(sock, encode('SET', 'ex', 'v', 'EX', '10')), '+OK\r\n');
    const ex = Number((await send(sock, encode('TTL', 'ex'))).slice(1));
    assert.ok(ex > 0 && ex <= 10, `EX ttl=${ex}`);

    assert.equal(await send(sock, encode('SET', 'px', 'v', 'PX', '5000')), '+OK\r\n');
    const px = Number((await send(sock, encode('TTL', 'px'))).slice(1));
    assert.ok(px > 0 && px <= 5, `PX ttl=${px}`);
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP: INFO and COMPACT', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    await send(sock, encode('SET', 'k', 'v'));
    const info = await send(sock, encode('INFO'));
    assert.ok(info.includes('minidb_version:0.0.1'), info);
    assert.ok(info.includes('keys:1'), info);
    assert.equal(await send(sock, encode('COMPACT')), '+OK\r\n');
    const info2 = await send(sock, encode('INFO'));
    assert.ok(info2.includes('compactions:1'), info2);
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP: QUIT closes the connection', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    await expect(sendUntilClose(sock, encode('QUIT'))).resolves.toBeUndefined();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP: inline (non-array) command path', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    // Redis inline protocol: a bare line of space-separated tokens.
    assert.equal(await send(sock, 'PING\r\n'), '+PONG\r\n');
    assert.equal(await send(sock, 'SET foo bar\r\n'), '+OK\r\n');
    assert.equal(await send(sock, 'GET foo\r\n'), '$3\r\nbar\r\n');
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP parser: oversized payload is discarded before the next PING', () => {
  const { maxBuf, payload, stream, expected } = makeOversizedPipeline();
  const results = parseChunks(new RespParser({ maxBuf }), [stream]);

  assert.deepEqual(results, expected);
  assert.equal(results.filter((result) => result.type === 'error').length, 1);
  assert.equal(results.filter((result) => result.type === 'command').length, 1);
  assert.ok(payload.includes(Buffer.from('*1\r\n$4\r\nPING\r\n')));
});

test('RESP parser: oversized results are stable across feed boundaries', () => {
  const { maxBuf, stream, expected } = makeOversizedPipeline();
  const baseline = parseChunks(new RespParser({ maxBuf }), [stream]);
  const headerEnd = stream.indexOf(Buffer.from('\r\n'), stream.indexOf(Buffer.from('$')) + 1) + 2;
  const payloadStart = stream.indexOf(Buffer.from('payload-'));
  const payloadEnd = payloadStart + Buffer.from('payload-*1\r\n$4\r\nPING\r\n-with-crlf').length;
  const trailerEnd = payloadEnd + 2;

  const fragmentations = [
    splitAt(stream, [1, 4, headerEnd - 1, headerEnd, payloadStart + 1, payloadEnd - 1, payloadEnd, trailerEnd]),
    Array.from(stream, (byte) => Buffer.from([byte])),
    splitAt(stream, [2, 3, 9, 17, 23, 31, 37, 43, 51]),
  ];
  assert.deepEqual(baseline, expected);
  for (const chunks of fragmentations) {
    assert.deepEqual(parseChunks(new RespParser({ maxBuf }), chunks), baseline);
  }
});

test('RESP parser: oversized arrays drain all remaining bulk arguments', () => {
  const maxBuf = 48;
  const payload = Buffer.from('oversized-*1\r\n$4\r\nPING\r\n-body');
  const frame = encodeBuffers(
    Buffer.from('ECHO'),
    payload,
    Buffer.from('*1\r\n$4\r\nPING\r\n'),
    Buffer.from('tail-argument'),
  );
  const results = parseChunks(new RespParser({ maxBuf }), [Buffer.concat([frame, Buffer.from(encode('PING'))])]);

  assert.deepEqual(results, [
    { type: 'error', message: `RESP request too large (>${maxBuf} bytes)` },
    { type: 'command', args: [Buffer.from('PING')] },
  ]);
});

test('RESP parser: oversized or malformed frames without a trusted boundary are fatal', () => {
  const unterminated = Buffer.concat([Buffer.from('*'), Buffer.alloc(16, 'x')]);
  assert.throws(
    () => parseChunks(new RespParser({ maxBuf: 16 }), [unterminated]),
    /RESP request too large \(>16 bytes\)/,
  );

  const payload = Buffer.alloc(24, 'x');
  const malformedOversized = Buffer.concat([
    Buffer.from(`*2\r\n$4\r\nECHO\r\n$${payload.length}\r\n`),
    payload,
    Buffer.from('XX'),
  ]);
  assert.throws(
    () => parseChunks(new RespParser({ maxBuf: 32 }), [malformedOversized]),
    /RESP protocol error: bulk payload missing CRLF/,
  );
});

test('RESP parser: array item caps fail early and the boundary remains usable', () => {
  assert.throws(
    () => parseChunks(new RespParser({ maxArrayItems: 3 }), [Buffer.from('*4\r\n')]),
    /RESP protocol error: array length exceeds 3 items/,
  );
  assert.throws(
    () => parseChunks(new RespParser(), [Buffer.from('*4097\r\n')]),
    /RESP protocol error: array length exceeds 4096 items/,
  );

  const boundary = encodeBuffers(Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0));
  const oneByteAtATime = Array.from(boundary, (byte) => Buffer.from([byte]));
  assert.deepEqual(parseChunks(new RespParser({ maxArrayItems: 3 }), oneByteAtATime), [
    { type: 'command', args: [Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0)] },
  ]);
});

test('RESP parser: inline byte and argument caps are fatal while boundaries work', () => {
  assert.deepEqual(parseChunks(new RespParser({ maxInlineBytes: 8 }), [Buffer.from('PING abc\r\n')]), [
    { type: 'command', args: [Buffer.from('PING'), Buffer.from('abc')] },
  ]);
  assert.throws(
    () => parseChunks(new RespParser({ maxInlineBytes: 8 }), [Buffer.from('PING abcd')]),
    /RESP protocol error: inline command exceeds 8 bytes/,
  );
  assert.throws(
    () => parseChunks(new RespParser({ maxArrayItems: 3 }), [Buffer.from('PING a b c\r\n')]),
    /RESP protocol error: inline command exceeds 3 arguments/,
  );

  assert.throws(
    () => parseChunks(new RespParser(), [Buffer.alloc(64 * 1024 + 1, 'x')]),
    /RESP protocol error: inline command exceeds 65536 bytes/,
  );
});

test('RESP parser: all 4096 empty bulk arguments complete once under byte and parameter splits', () => {
  const emptyArg = Buffer.from('$0\r\n\r\n');
  const header = Buffer.from('*4096\r\n');
  const byParameter = [header, ...Array.from({ length: 4096 }, () => emptyArg)];
  const frame = Buffer.concat(byParameter);
  const byByte = Array.from(frame, (byte) => Buffer.from([byte]));

  const parameterResults = parseChunks(new RespParser(), byParameter);
  const byteResults = parseChunks(new RespParser(), byByte);
  assert.deepEqual(byteResults, parameterResults);
  assert.equal(parameterResults.length, 1);
  assert.equal(parameterResults[0]!.type, 'command');
  if (parameterResults[0]!.type === 'command') {
    assert.equal(parameterResults[0]!.args.length, 4096);
    assert.ok(parameterResults[0]!.args.every((arg) => arg.length === 0));
  }
});

test('RESP parser: frame budget includes completed arguments before a later payload', () => {
  const maxBuf = 32;
  const completed = Buffer.from('$0\r\n\r\n');
  const laterPayload = Buffer.alloc(20, 'x');
  const frame = Buffer.concat([
    Buffer.from('*2\r\n'),
    completed,
    Buffer.from(`$${laterPayload.length}\r\n`),
    laterPayload,
    Buffer.from('\r\n'),
  ]);
  const results = parseChunks(new RespParser({ maxBuf }), [Buffer.concat([frame, Buffer.from(encode('PING'))])]);

  assert.deepEqual(results, [
    { type: 'error', message: `RESP request too large (>${maxBuf} bytes)` },
    { type: 'command', args: [Buffer.from('PING')] },
  ]);
});

test('RESP parser: CRLF split across chunks survives grow and consumed-prefix compaction', () => {
  const parser = new RespParser({ maxBuf: 16 * 1024 });
  const firstPayload = 'a'.repeat(6000);
  const first = Buffer.from(encode('ECHO', firstPayload));
  const firstResults = parseChunks(parser, splitAt(first, [1024, 2048, 3072, 4096, 5120]));
  assert.deepEqual(firstResults, [{ type: 'command', args: [Buffer.from('ECHO'), Buffer.from(firstPayload)] }]);

  const followupPayload = 'b'.repeat(3000);
  const followup = Buffer.from(encode('ECHO', followupPayload));
  const followupResults = parseChunks(parser, [followup.subarray(0, followup.length - 1), followup.subarray(followup.length - 1)]);
  assert.deepEqual(followupResults, [{ type: 'command', args: [Buffer.from('ECHO'), Buffer.from(followupPayload)] }]);
});

test('RESP parser: every RESP CRLF can be split at a feed boundary', () => {
  const frame = Buffer.from(encode('PING', 'crlf-boundary'));
  const cuts: number[] = [];
  let searchFrom = 0;
  while (searchFrom < frame.length) {
    const index = frame.indexOf(Buffer.from('\r\n'), searchFrom);
    if (index === -1) break;
    cuts.push(index + 1);
    searchFrom = index + 2;
  }

  assert.deepEqual(parseChunks(new RespParser(), splitAt(frame, cuts)), [
    { type: 'command', args: [Buffer.from('PING'), Buffer.from('crlf-boundary')] },
  ]);
});

test('RESP parser: exact inline limit remains valid when body CRLF is split', () => {
  const body = Buffer.from('PING abc');
  const frame = Buffer.concat([body, Buffer.from('\r\n')]);
  const coalesced = parseChunks(new RespParser({ maxInlineBytes: body.length }), [frame]);
  const split = parseChunks(new RespParser({ maxInlineBytes: body.length }), [body, Buffer.from('\r'), Buffer.from('\n')]);

  assert.deepEqual(split, coalesced);
  assert.deepEqual(coalesced, [{ type: 'command', args: [Buffer.from('PING'), Buffer.from('abc')] }]);
});

test('RESP parser: 16-digit leading-zero array and bulk lengths survive split CRLFs', () => {
  const emptyArg = Buffer.from('$0\r\n\r\n');
  const arrayFrame = Buffer.concat([Buffer.from('*0000000000000003\r\n'), emptyArg, emptyArg, emptyArg]);
  const arrayCoalesced = parseChunks(new RespParser(), [arrayFrame]);
  const arraySplit = parseChunks(new RespParser(), splitCrlfPairs(arrayFrame));
  assert.deepEqual(arraySplit, arrayCoalesced);
  assert.deepEqual(arrayCoalesced, [
    { type: 'command', args: [Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0)] },
  ]);

  const bulkFrame = Buffer.from('*1\r\n$0000000000000000\r\n\r\n');
  const bulkCoalesced = parseChunks(new RespParser(), [bulkFrame]);
  const bulkSplit = parseChunks(new RespParser(), splitCrlfPairs(bulkFrame));
  assert.deepEqual(bulkSplit, bulkCoalesced);
  assert.deepEqual(bulkCoalesced, [{ type: 'command', args: [Buffer.alloc(0)] }]);
});

test('RESP network: fatal inline frames close once and drop coalesced commands', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    const oversizedInline = Buffer.alloc(64 * 1024 + 1, 'x');
    const response = await sendAndCollectUntilClose(sock, Buffer.concat([oversizedInline, Buffer.from(encode('PING'))]));
    assert.equal(response, '-ERR RESP protocol error: inline command exceeds 65536 bytes\r\n');
    assert.equal(response.split('-ERR ').length - 1, 1);
    assert.ok(!response.includes('+PONG'), 'coalesced PING must not execute after fatal parser close');

    const healthy = await connect(srv.port);
    assert.equal(await send(healthy, encode('PING')), '+PONG\r\n');
    healthy.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP: invalid bulk lengths return protocol errors without echoing data', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    for (const length of ['-1', 'NaN', 'not-a-number', '1.5']) {
      const sock = await connect(srv.port);
      const sentinel = 'UNINITIALIZED_DATA';
      const malformed = `*2\r\n$4\r\nECHO\r\n$${length}\r\n${sentinel}\r\n`;
      const response = await send(sock, malformed);
      assert.equal(response, '-ERR RESP protocol error: invalid bulk length\r\n');
      assert.ok(!response.includes(sentinel), `protocol error must not echo ${sentinel}`);
      sock.end();
    }

    // Fatal parser errors close only the malformed client; use a fresh client
    // to assert that the listening server itself remains healthy.
    const healthy = await connect(srv.port);
    assert.equal(await send(healthy, encode('PING')), '+PONG\r\n');
    healthy.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP: a bulk payload without CRLF is rejected and the server stays healthy', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    const malformed = Buffer.from('*2\r\n$4\r\nECHO\r\n$3\r\nabcXX');
    assert.equal(await send(sock, malformed), '-ERR RESP protocol error: bulk payload missing CRLF\r\n');
    sock.end();

    const healthy = await connect(srv.port);
    assert.equal(await send(healthy, encode('PING')), '+PONG\r\n');
    healthy.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP: geometric buffering and consumed-prefix compaction preserve pipelined bytes', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    sock.setNoDelay(true);

    // Fragment an incomplete request into 1KiB writes. Its 12KiB payload
    // forces the parser to grow its buffer geometrically before it can reply.
    const firstPayload = `first-${'a'.repeat(12 * 1024)}`;
    const firstRequest = Buffer.from(encode('ECHO', firstPayload));
    const firstReply = Buffer.from(`$${Buffer.byteLength(firstPayload)}\r\n${firstPayload}\r\n`);
    const firstReplyPromise = collectBytes(sock, firstReply.length);
    for (let offset = 0; offset < firstRequest.length; offset += 1024) {
      const end = Math.min(offset + 1024, firstRequest.length);
      await new Promise<void>((resolve, reject) => {
        sock.write(firstRequest.subarray(offset, end), (error?: Error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(await firstReplyPromise, firstReply);

    // The first request has been consumed, leaving its large backing buffer
    // with only a small tail. A single >tail pipeline makes append() compact
    // that consumed prefix before parsing all four commands in order.
    const followupPayloads = ['b'.repeat(2048), 'c'.repeat(2048), 'd'.repeat(2048)];
    const followupRequest = Buffer.concat([
      Buffer.from(encode('ECHO', followupPayloads[0]!)),
      Buffer.from(encode('PING', 'tail')),
      Buffer.from(encode('ECHO', followupPayloads[1]!)),
      Buffer.from(encode('ECHO', followupPayloads[2]!)),
    ]);
    const followupReply = Buffer.concat([
      Buffer.from(`$${followupPayloads[0]!.length}\r\n${followupPayloads[0]}\r\n`),
      Buffer.from('$4\r\ntail\r\n'),
      Buffer.from(`$${followupPayloads[1]!.length}\r\n${followupPayloads[1]}\r\n`),
      Buffer.from(`$${followupPayloads[2]!.length}\r\n${followupPayloads[2]}\r\n`),
    ]);
    const followupReplyPromise = collectBytes(sock, followupReply.length);
    sock.write(followupRequest);
    assert.deepEqual(await followupReplyPromise, followupReply);
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// Accumulate reply bytes until `done` accepts them (replies may span chunks).
function collectUntil(sock: net.Socket, done: (s: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for reply; got ${buf.length} bytes`)), 20_000);
    sock.on('data', (d) => {
      buf += d.toString();
      if (done(buf)) {
        clearTimeout(timer);
        resolve(buf);
      }
    });
  });
}

test('RESP: a client aborting mid-large-reply does not kill the server', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    sock.on('error', () => {}); // the test client itself may see the RST
    const big = 'x'.repeat(4 * 1024 * 1024);
    assert.equal(await send(sock, encode('SET', 'big', big)), '+OK\r\n');
    // Ask for the large value, then reset the connection without reading the
    // reply: the server hits EPIPE/ECONNRESET while writing it out.
    sock.write(encode('GET', 'big'));
    await new Promise((r) => setTimeout(r, 20));
    sock.destroy();
    // Give the server a moment to hit the write failure, then prove a fresh
    // connection is still being served.
    await new Promise((r) => setTimeout(r, 100));
    const sock2 = await connect(srv.port);
    assert.equal(await send(sock2, encode('PING')), '+PONG\r\n');
    sock2.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP: an oversized request gets -ERR and the connection recovers', { timeout: 30_000 }, async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    // 65MB of bulk payload crosses the parser's 64MB cap.
    const big = Buffer.alloc(65 * 1024 * 1024, 'x'.charCodeAt(0));
    const head = Buffer.from(`*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$${big.length}\r\n`);
    sock.write(Buffer.concat([head, big, Buffer.from('\r\n')]));
    // Pipelined right behind it: once the parser recovers from the -ERR this
    // fresh small command must still be answered.
    sock.write(encode('PING'));
    const data = await collectUntil(sock, (s) => s.includes('+PONG'));
    const tooLarge = data.indexOf('too large');
    const pong = data.indexOf('+PONG');
    assert.ok(tooLarge !== -1, `expected a too-large -ERR, got ${JSON.stringify(data.slice(0, 120))}`);
    assert.ok(pong > tooLarge, 'PING after the oversized request must be answered');
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP: one bad command does not starve its pipelined siblings', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    // The 129-byte key exceeds MAX_KEY_LEN so SET throws inside the handler;
    // the two PINGs in the very same chunk must still be answered, in order.
    const key = 'k'.repeat(129);
    sock.write(encode('SET', key, 'v') + encode('PING') + encode('PING'));
    const data = await collectUntil(sock, (s) => s.endsWith('+PONG\r\n+PONG\r\n'));
    assert.match(data, /^-ERR [^\r]*\r\n\+PONG\r\n\+PONG\r\n$/);
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
