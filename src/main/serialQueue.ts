// Runs asynchronous tasks one at a time, in the order they were queued.

/** Queue a task; it starts once every task queued before it has settled, and
 *  its own result or rejection goes back to its caller only. */
export type SerialQueue = <T>(task: () => Promise<T>) => Promise<T>;

export function createSerialQueue(): SerialQueue {
  // Always fulfilled, so one rejected task never stops the ones behind it.
  let tail: Promise<void> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
