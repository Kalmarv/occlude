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
 * are the ones that went missing. The loop ends when the stream closes
 * (the driver disconnected), when the driver has let go of this port, or —
 * announced by name, never quietly — when the reader stops with the port
 * still open: `port.readable` went null or the stream ended, and a driver
 * that keeps believing it is connected is worse than one that knows.
 */

export interface ReadablePort {
  readable: ReadableStream<Uint8Array> | null;
}

export async function readLines(
  port: ReadablePort,
  onLine: (line: string) => void,
  onError: (error: unknown) => void,
  isOpen: () => boolean,
): Promise<void> {
  const gone = new Error('the serial reader stopped while the port was still open — the link is down');
  while (isOpen() && port.readable) {
    const decoder = new TextDecoder();
    let buf = '';
    const reader = port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { if (isOpen()) onError(gone); return; }
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split(/[\r\n]+/);
        buf = parts.pop() ?? '';
        for (const line of parts) if (line.length > 0) onLine(line);
      }
    } catch (error) {
      onError(error);
    } finally {
      reader.releaseLock();
    }
    // Never a hot loop, whatever a port does after an error.
    await new Promise((r) => setTimeout(r, 10));
  }
  // The loop fell out with the port still ours: `port.readable` went null
  // (a fatal device error). Returning quietly left the driver deaf and still
  // reporting itself connected, so the stall watchdog called the link down
  // twenty seconds later with nothing in the log to say why.
  if (isOpen()) onError(gone);
}

/** A read error as the serial log writes it: its name and message. */
export function describeReadError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
