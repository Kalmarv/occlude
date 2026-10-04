/**
 * The one reader of a Web Serial port, shared by the EBB and GRBL drivers:
 * bytes in, lines out, for as long as the port is open.
 *
 * A read can fail without the port being gone. Web Serial names the
 * recoverable errors (BufferOverrunError, FramingError, ParityError,
 * BreakError): the readable stream errors, and the port hands out a fresh
 * one. A reader that stopped at the first error left the page deaf while
 * the board went on answering, and the watchdog then called the link down.
 * So the error is written to the serial log by name and reading goes on
 * from the next stream; a partial line is dropped with it, since its bytes
 * are the ones that went missing. The loop ends when the driver stops it
 * (`stop()`), or — announced by name, never quietly — when the reader
 * stops with the port still open: `port.readable` went null or the stream
 * ended, and a driver that keeps believing it is connected is worse than
 * one that knows.
 *
 * `stop()` cancels the read in flight and releases the stream's lock. Web
 * Serial refuses to close a port whose readable is locked, so a driver
 * stops its reader before `port.close()`; without that, a disconnect left
 * the port open underneath the page.
 */

export interface ReadablePort {
  readable: ReadableStream<Uint8Array> | null;
}

/** A running reader: stop it before closing the port. */
export interface Reading {
  stop(): Promise<void>;
}

export function readLines(
  port: ReadablePort,
  onLine: (line: string) => void,
  onError: (error: unknown) => void,
): Reading {
  const gone = new Error('the serial reader stopped while the port was still open — the link is down');
  let stopped = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const loop = (async (): Promise<void> => {
    while (!stopped && port.readable) {
      const decoder = new TextDecoder();
      let buf = '';
      reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) { if (!stopped) onError(gone); return; }
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split(/[\r\n]+/);
          buf = parts.pop() ?? '';
          for (const line of parts) if (line.length > 0) onLine(line);
        }
      } catch (error) {
        if (!stopped) onError(error);
      } finally {
        reader.releaseLock();
        reader = null;
      }
      // Never a hot loop, whatever a port does after an error.
      await new Promise((r) => setTimeout(r, 10));
    }
    // The loop fell out with the reader still wanted: `port.readable` went
    // null (a fatal device error). Returning quietly left the driver deaf
    // and still reporting itself connected.
    if (!stopped) onError(gone);
  })();
  return {
    async stop(): Promise<void> {
      stopped = true;
      await reader?.cancel().catch(() => undefined);
      await loop;
    },
  };
}

/** A read error as the serial log writes it: its name and message. */
export function describeReadError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
