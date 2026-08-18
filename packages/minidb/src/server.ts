// src/server.ts
//
// A minimal RESP (REdis Serialization Protocol) TCP front-end for MiniDb, so
// existing Redis clients (redis-cli, ioredis, ...) can talk to it.

import net from 'node:net';
import type { Socket } from 'node:net';
import { MiniDb } from './index.js';

const CRLF = '\r\n';
const NIL = `$-1${CRLF}`;
const DEFAULT_MAX_ARRAY_ITEMS = 4096;
const DEFAULT_MAX_INLINE_BYTES = 64 * 1024;

const reply = {
  ok: () => `+OK${CRLF}`,
  pong: () => `+PONG${CRLF}`,
  int: (n: number) => `:${n}${CRLF}`,
  err: (m: string) => `-ERR ${m}${CRLF}`,
  // Bulk replies carry raw bytes. Build a Buffer so non-ASCII / binary values
  // are written verbatim instead of being re-encoded as UTF-8 (which corrupted
  // them and desynced the protocol when `socket.write(string)` defaulted to
  // utf8).
  bulk: (v: unknown): Buffer => {
    if (v === undefined || v === null) return Buffer.from(NIL);
    const b = Buffer.isBuffer(v) ? v : Buffer.from(String(v as string));
    return Buffer.concat([Buffer.from(`$${b.length}${CRLF}`), b, Buffer.from(CRLF)]);
  },
  array: (items: unknown[]): Buffer => {
    const parts: Buffer[] = [Buffer.from(`*${items.length}${CRLF}`)];
    for (const it of items) parts.push(reply.bulk(it));
    return Buffer.concat(parts);
  },
};

const OVERSIZED_FRAME = Symbol('oversized RESP frame');

type RespParserResult =
  | { type: 'command'; args: Buffer[] }
  | { type: 'error'; message: string };

type OversizedDiscardState = {
  phase: 'payload' | 'trailer' | 'header';
  payloadRemaining: number;
  trailerIndex: 0 | 1;
  remainingArgs: number;
  header: number[];
  errorReported: boolean;
};

type RespArrayState = {
  argc: number;
  args: Buffer[];
  nextArg: number;
  frameBytes: number;
};

class RespParserFatalError extends Error {
  constructor(message: string, readonly alreadyReplied: boolean) {
    super(message);
  }
}

export class RespParser {
  private buf: Buffer = Buffer.alloc(0);
  private start = 0;
  private end = 0;
  private discard: OversizedDiscardState | null = null;
  private array: RespArrayState | null = null;
  private crlfSearchOffset = -1;
  private crlfSearchFrom = 0;
  private readonly maxBuf: number;
  private readonly maxArrayItems: number;
  private readonly maxInlineBytes: number;

  constructor({
    maxBuf = 64 * 1024 * 1024,
    maxArrayItems = DEFAULT_MAX_ARRAY_ITEMS,
    maxInlineBytes = DEFAULT_MAX_INLINE_BYTES,
  }: { maxBuf?: number; maxArrayItems?: number; maxInlineBytes?: number } = {}) {
    this.maxBuf = maxBuf;
    this.maxArrayItems = maxArrayItems;
    this.maxInlineBytes = Math.min(maxInlineBytes, maxBuf);
  }

  *feed(chunk: Buffer): Generator<RespParserResult> {
    let input = chunk;
    let offset = 0;

    while (offset < input.length || this.discard !== null) {
      if (this.discard !== null) {
        const remainder = this.consumeDiscard(input.subarray(offset));
        if (this.discard !== null) return;
        input = remainder;
        offset = 0;
        if (input.length === 0) return;
      }

      const buffered = this.end - this.start;
      const frameBytes = this.array?.frameBytes ?? 0;
      const available = this.maxBuf - frameBytes - buffered;
      if (available <= 0) {
        this.failTooLarge();
      }
      const take = Math.min(available, input.length - offset);
      this.append(input.subarray(offset, offset + take));
      offset += take;

      let waitingForMore = false;
      while (this.start < this.end) {
        const parsed = this.tryParse();
        if (parsed === OVERSIZED_FRAME) {
          yield {
            type: 'error',
            message: `RESP request too large (>${this.maxBuf} bytes)`,
          };
          this.markOversizedErrorReported();
          break;
        }
        if (parsed === null) {
          waitingForMore = true;
          break;
        }
        yield { type: 'command', args: parsed };
      }

      if (this.discard !== null) continue;
      if (offset >= input.length) return;
      if (waitingForMore && this.end - this.start >= this.maxBuf) {
        // The request has no trustworthy frame boundary within the cap (for
        // example, an unterminated inline command). Continuing on the same
        // connection could reinterpret its tail as a fresh command.
        this.failTooLarge();
      }
    }
  }

  private append(chunk: Buffer): void {
    const buffered = this.end - this.start;
    if (this.buf.length - this.end < chunk.length) {
      if (this.start > 0 && this.buf.length - buffered >= chunk.length) {
        this.buf.copyWithin(0, this.start, this.end);
        this.start = 0;
        this.end = buffered;
        this.resetCrlfSearch();
      } else {
        // Socket payloads commonly arrive in many small chunks. Repeated
        // Buffer.concat calls would copy the entire accumulated request for
        // every chunk (quadratic work for a request near the 64 MiB cap). Grow
        // geometrically instead, compacting already-consumed bytes on the way.
        const needed = buffered + chunk.length;
        const capacity = Math.min(this.maxBuf, Math.max(needed, this.buf.length ? this.buf.length * 2 : 4096));
        const next = Buffer.allocUnsafe(capacity);
        if (buffered) this.buf.copy(next, 0, this.start, this.end);
        this.buf = next;
        this.start = 0;
        this.end = buffered;
        this.resetCrlfSearch();
      }
    }
    chunk.copy(this.buf, this.end);
    this.end += chunk.length;
  }

  private resetBuffer(): void {
    this.buf = Buffer.alloc(0);
    this.start = 0;
    this.end = 0;
    this.resetCrlfSearch();
  }

  private reset(): void {
    this.resetBuffer();
    this.discard = null;
    this.array = null;
  }

  private markOversizedErrorReported(): void {
    if (this.discard !== null) this.discard.errorReported = true;
  }

  private indexOfCrlf(offset: number): number {
    if (this.crlfSearchOffset !== offset) {
      this.crlfSearchOffset = offset;
      this.crlfSearchFrom = offset;
    }
    const relative = this.buf.subarray(this.crlfSearchFrom, this.end).indexOf(CRLF);
    if (relative !== -1) {
      const found = this.crlfSearchFrom + relative;
      this.resetCrlfSearch();
      return found;
    }
    // Keep the final byte in the next search so a CR/LF pair split across
    // socket chunks is still detected, without rescanning the whole prefix.
    this.crlfSearchFrom = Math.max(offset, this.end - 1);
    return -1;
  }

  private resetCrlfSearch(): void {
    this.crlfSearchOffset = -1;
    this.crlfSearchFrom = 0;
  }

  private pendingFieldWidth(start: number): number {
    const trailingCr = this.end > start && this.buf[this.end - 1] === 0x0d ? 1 : 0;
    return this.end - start - trailingCr;
  }

  private failProtocol(message: string): never {
    const alreadyReplied = this.discard?.errorReported === true;
    this.reset();
    throw new RespParserFatalError(`RESP protocol error: ${message}`, alreadyReplied);
  }

  private failTooLarge(): never {
    const alreadyReplied = this.discard?.errorReported === true;
    this.reset();
    throw new RespParserFatalError(
      `RESP request too large (>${this.maxBuf} bytes)`,
      alreadyReplied,
    );
  }

  private parseUnsignedInteger(start: number, end: number, label: string): number {
    const width = end - start;
    // Number.MAX_SAFE_INTEGER has 16 decimal digits. Rejecting wider fields
    // before converting also prevents an attacker from allocating a huge
    // temporary string for a malformed numeric header.
    if (width < 1 || width > 16) this.failProtocol(`invalid ${label}`);
    let value = 0;
    for (let i = start; i < end; i++) {
      const digit = this.buf[i]! - 0x30;
      if (digit < 0 || digit > 9) this.failProtocol(`invalid ${label}`);
      value = value * 10 + digit;
    }
    if (!Number.isSafeInteger(value)) this.failProtocol(`invalid ${label}`);
    return value;
  }

  private beginOversizedDiscard(
    argc: number,
    currentArg: number,
    payloadLength: number,
    payloadStart: number,
  ): void {
    const bufferedTail = this.buf.subarray(payloadStart, this.end);
    this.discard = {
      phase: 'payload',
      payloadRemaining: payloadLength,
      trailerIndex: 0,
      remainingArgs: argc - currentArg - 1,
      header: [],
      errorReported: false,
    };
    this.array = null;
    this.resetBuffer();
    const remainder = this.consumeDiscard(bufferedTail);
    // The declared frame is larger than maxBuf, while bufferedTail came from a
    // buffer bounded by maxBuf, so it cannot contain bytes after that frame.
    if (remainder.length !== 0) this.failProtocol('invalid oversized frame boundary');
  }

  private parseDiscardHeader(header: readonly number[]): number {
    if (header.length < 4 || header[0] !== 0x24) {
      this.failProtocol('invalid bulk header while discarding oversized request');
    }
    const digits = header.slice(1, -2);
    if (digits.length < 1 || digits.length > 16) this.failProtocol('invalid bulk length');
    let value = 0;
    for (const byte of digits) {
      const digit = byte - 0x30;
      if (digit < 0 || digit > 9) this.failProtocol('invalid bulk length');
      value = value * 10 + digit;
    }
    if (!Number.isSafeInteger(value)) this.failProtocol('invalid bulk length');
    return value;
  }

  private consumeDiscard(input: Buffer): Buffer {
    let offset = 0;
    while (offset < input.length && this.discard !== null) {
      const state = this.discard;
      if (state.phase === 'payload') {
        const take = Math.min(state.payloadRemaining, input.length - offset);
        state.payloadRemaining -= take;
        offset += take;
        if (state.payloadRemaining === 0) state.phase = 'trailer';
        continue;
      }

      if (state.phase === 'trailer') {
        const expected = state.trailerIndex === 0 ? 0x0d : 0x0a;
        if (input[offset] !== expected) this.failProtocol('bulk payload missing CRLF');
        offset++;
        if (state.trailerIndex === 0) {
          state.trailerIndex = 1;
          continue;
        }
        if (state.remainingArgs === 0) {
          this.discard = null;
          break;
        }
        state.phase = 'header';
        state.trailerIndex = 0;
        state.header = [];
        continue;
      }

      const byte = input[offset]!;
      state.header.push(byte);
      offset++;
      if (state.header.length === 1 && byte !== 0x24) {
        this.failProtocol('invalid bulk header while discarding oversized request');
      }
      if (state.header.length > 19) this.failProtocol('invalid bulk length');
      const width = state.header.length;
      if (width < 2 || state.header[width - 2] !== 0x0d || state.header[width - 1] !== 0x0a) {
        continue;
      }
      state.payloadRemaining = this.parseDiscardHeader(state.header);
      state.remainingArgs--;
      state.phase = 'payload';
      state.header = [];
    }
    return input.subarray(offset);
  }

  private tryParse(): Buffer[] | null | typeof OVERSIZED_FRAME {
    if (this.array === null) {
      if (this.buf[this.start] !== 0x2a /* '*' */) {
        const idx = this.indexOfCrlf(this.start);
        const inlineBytes =
          idx === -1 ? this.pendingFieldWidth(this.start) : idx - this.start;
        if (inlineBytes > this.maxInlineBytes) {
          this.failProtocol(`inline command exceeds ${this.maxInlineBytes} bytes`);
        }
        if (idx === -1) return null;
        const line = this.buf.subarray(this.start, idx).toString();
        this.start = idx + 2;
        const args = line.split(' ').filter(Boolean);
        if (args.length > this.maxArrayItems) {
          this.failProtocol(`inline command exceeds ${this.maxArrayItems} arguments`);
        }
        return args.map((s) => Buffer.from(s));
      }

      const countStart = this.start + 1;
      const countEnd = this.indexOfCrlf(countStart);
      if (countEnd === -1) {
        if (this.pendingFieldWidth(countStart) > 16) {
          this.failProtocol('invalid array length');
        }
        return null;
      }
      const argc = this.parseUnsignedInteger(countStart, countEnd, 'array length');
      if (argc > this.maxArrayItems) {
        this.failProtocol(`array length exceeds ${this.maxArrayItems} items`);
      }
      const headerEnd = countEnd + 2;
      this.array = {
        argc,
        args: [],
        nextArg: 0,
        frameBytes: headerEnd - this.start,
      };
      this.start = headerEnd;
      if (argc === 0) {
        this.array = null;
        return [];
      }
    }

    const state = this.array;
    while (state.nextArg < state.argc) {
      const argStart = this.start;
      if (argStart >= this.end) return null;
      if (this.buf[argStart] !== 0x24 /* '$' */) {
        this.failProtocol('expected bulk string');
      }
      const lengthStart = argStart + 1;
      const lengthEnd = this.indexOfCrlf(lengthStart);
      if (lengthEnd === -1) {
        if (this.pendingFieldWidth(lengthStart) > 16) {
          this.failProtocol('invalid bulk length');
        }
        return null;
      }
      const len = this.parseUnsignedInteger(lengthStart, lengthEnd, 'bulk length');
      const payloadStart = lengthEnd + 2;
      const headerBytes = payloadStart - argStart;
      if (len > this.maxBuf - state.frameBytes - headerBytes - 2) {
        this.beginOversizedDiscard(state.argc, state.nextArg, len, payloadStart);
        return OVERSIZED_FRAME;
      }
      if (this.end - payloadStart < len + 2) return null;
      if (this.buf[payloadStart + len] !== 0x0d || this.buf[payloadStart + len + 1] !== 0x0a) {
        this.failProtocol('bulk payload missing CRLF');
      }
      state.args.push(Buffer.from(this.buf.subarray(payloadStart, payloadStart + len)));
      state.nextArg++;
      state.frameBytes += headerBytes + len + 2;
      this.start = payloadStart + len + 2;
    }

    const args = state.args;
    this.array = null;
    return args;
  }
}

async function handle(db: MiniDb<string>, args: Buffer[]): Promise<string | Buffer | null> {
  const cmd = args[0]!.toString().toUpperCase();
  const S = (i: number): string | undefined => (args[i] === undefined ? undefined : args[i]!.toString());

  switch (cmd) {
    case 'PING':
      return args[1] ? reply.bulk(S(1)) : reply.pong();
    case 'ECHO':
      return reply.bulk(S(1));
    case 'GET': {
      const v = db.get(S(1)!);
      return reply.bulk(v === undefined ? null : v);
    }
    case 'SET': {
      const key = S(1)!;
      const val = S(2)!;
      let ttl: number | undefined;
      for (let i = 3; i < args.length; i++) {
        const opt = S(i)!.toUpperCase();
        if (opt === 'EX') ttl = Number(S(++i)) * 1000;
        else if (opt === 'PX') ttl = Number(S(++i));
      }
      await db.set(key, val, ttl ? { ttl } : {});
      return reply.ok();
    }
    case 'DEL': {
      let n = 0;
      for (let i = 1; i < args.length; i++) if (await db.del(S(i)!)) n++;
      return reply.int(n);
    }
    case 'EXISTS':
      return reply.int(db.has(S(1)!) ? 1 : 0);
    case 'MGET': {
      const out: unknown[] = [];
      for (let i = 1; i < args.length; i++) {
        const v = db.get(S(i)!);
        out.push(v === undefined ? null : v);
      }
      return reply.array(out);
    }
    case 'MSET': {
      const entries: (readonly [string, string])[] = [];
      for (let i = 1; i + 1 < args.length; i += 2) entries.push([S(i)!, S(i + 1)!]);
      await db.mset(entries); // atomic batch (single WAL frame), like Redis MSET
      return reply.ok();
    }
    case 'TTL':
      return reply.int(Math.trunc(db.ttl(S(1)!) / 1000));
    case 'DBSIZE':
      return reply.int(db.size);
    case 'COMPACT':
      await db.compact();
      return reply.ok();
    case 'INFO':
      return reply.bulk(`minidb_version:0.0.1${CRLF}keys:${db.size}${CRLF}compactions:${db.stats.compactions}${CRLF}`);
    case 'QUIT':
      return null;
    default:
      return reply.err(`unknown command '${cmd}'`);
  }
}

export interface ServerOptions {
  dir: string;
  port?: number;
  host?: string;
  fsyncPolicy?: 'always' | 'everysec' | 'no';
}

export interface ServerHandle {
  server: net.Server;
  db: MiniDb<string>;
  close: () => Promise<void>;
  port: number;
  host: string;
}

export async function startServer({ dir, port = 6379, host = '127.0.0.1', fsyncPolicy = 'everysec' }: ServerOptions): Promise<ServerHandle> {
  const db = (await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy })) as MiniDb<string>;
  const server = net.createServer((socket: Socket) => {
    const parser = new RespParser();
    // Serialize per-connection processing: a new chunk's commands are queued
    // behind the previous chunk's in-flight work, so replies always leave in
    // request order. Without this, a slow command in one packet (e.g. SET with
    // fsync 'always') let replies from the next packet overtake it, breaking
    // pipelined clients.
    let queue: Promise<void> = Promise.resolve();
    let closing = false;
    // A client that resets the connection while a large reply is being written
    // makes the next write fail with EPIPE/ECONNRESET. Without an 'error'
    // listener that event becomes an uncaught exception and takes the whole
    // process down, so swallow it: the connection is dead either way, and the
    // queued work below skips further writes to it.
    socket.on('error', () => {});
    // Never write to a destroyed socket: write-after-destroy would just
    // surface as another 'error' event on the dead connection.
    const send = (res: string | Buffer): void => {
      if (!closing && !socket.destroyed) socket.write(res);
    };
    const closeConnection = (payload?: string): void => {
      if (closing) return;
      closing = true;
      socket.pause();
      if (socket.destroyed) return;
      socket.end(payload ?? '', () => socket.destroy());
    };
    socket.on('data', (chunk: Buffer) => {
      if (closing) return;
      queue = queue.then(async () => {
        if (closing || socket.destroyed) return;
        try {
          for (const result of parser.feed(chunk)) {
            if (closing || socket.destroyed) return;
            if (result.type === 'error') {
              send(reply.err(result.message));
              continue;
            }
            let res: string | Buffer | null;
            try {
              res = await handle(db, result.args);
            } catch (e) {
              // One failing command must not starve the replies of the
              // commands already parsed from the same chunk.
              res = reply.err((e as Error).message);
            }
            if (res === null) {
              closeConnection();
              return;
            }
            send(res);
          }
        } catch (e) {
          const message = (e as Error).message;
          if (e instanceof RespParserFatalError) {
            // A malformed request without a trustworthy frame boundary cannot
            // be recovered safely: flush the error and close rather than
            // reinterpret attacker-controlled tail bytes as new commands.
            closeConnection(e.alreadyReplied ? undefined : reply.err(message));
            return;
          }
          closeConnection(reply.err(message));
        }
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const actualPort = (server.address() as net.AddressInfo).port;

  const close = async (): Promise<void> => {
    server.close();
    await db.close();
  };
  process.on('SIGINT', () => {
    void close().then(() => process.exit(0));
  });
  return { server, db, close, port: actualPort, host };
}

// Run directly: node --import tsx src/server.ts --dir ./data --port 6379
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const arg = (name: string, def: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? def : argv[i + 1]!;
  };
  const dir = arg('dir', './data');
  const port = Number(arg('port', '6379'));
  const fsyncPolicy = arg('fsync', 'everysec') as 'always' | 'everysec' | 'no';
  const { host, port: p } = await startServer({ dir, port, fsyncPolicy });
  console.log(`minidb RESP server listening on ${host}:${p} (dir=${dir}, fsync=${fsyncPolicy})`);
}
