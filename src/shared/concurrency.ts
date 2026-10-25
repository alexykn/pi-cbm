/** Let one caller stop waiting on a shared promise without cancelling it for the others. */
export async function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined, cancelledMessage: string): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new Error(cancelledMessage);
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(new Error(cancelledMessage));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];

  const workerCount = Math.max(1, Math.min(Math.floor(limit), items.length));
  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
