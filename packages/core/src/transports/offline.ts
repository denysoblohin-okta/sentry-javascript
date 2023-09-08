import type { Envelope, InternalBaseTransportOptions, Transport, TransportMakeRequestResponse } from '@sentry/types';
import { envelopeContainsItemType, logger, parseRetryAfterHeader } from '@sentry/utils';

export const MIN_DELAY = 100; // 100 ms
export const START_DELAY = 5_000; // 5 seconds
const MAX_DELAY = 3.6e6; // 1 hour

function log(msg: string, error?: Error): void {
  __DEBUG_BUILD__ && logger.info(`[Offline]: ${msg}`, error);
}

export interface OfflineStore {
  insert(env: Envelope, toStart?: boolean): Promise<void>;
  pop(offset?: number): Promise<Envelope | undefined>;
  size(): Promise<number>;
  clear(): Promise<void>;
}

export type CreateOfflineStore = (options: OfflineTransportOptions) => OfflineStore;

export interface OfflineTransportOptions extends InternalBaseTransportOptions {
  /**
   * A function that creates the offline store instance.
   */
  createStore?: CreateOfflineStore;

  /**
   * Flush the offline store shortly after startup.
   *
   * Defaults: false
   */
  flushAtStartup?: boolean;

  /**
   * Always insert data to offline store until `flush` is called manually to send all queue to server
   *
   * Defaults: false
   */
  fullOffline?: boolean;

  /**
   * Called before an event is stored.
   *
   * Return false to drop the envelope rather than store it.
   *
   * @param envelope The envelope that failed to send.
   * @param error The error that occurred.
   * @param retryDelay The current retry delay in milliseconds.
   */
  shouldStore?: (envelope: Envelope, error: Error, retryDelay: number) => boolean | Promise<boolean>;
}

type Timer = number | { unref?: () => void };

/**
 * Wraps a transport and stores and retries events when they fail to send.
 * With `fullOffline` mode, it saves events to the store until `flush` is called
 *
 * @param createTransport The transport to wrap.
 */
export function makeOfflineTransport<TO>(
  createTransport: (options: TO) => Transport,
): (options: TO & OfflineTransportOptions) => Transport {
  return options => {
    const transport = createTransport(options);
    const store = options.createStore ? options.createStore(options) : undefined;

    let retryDelay = 0;
    let flushTimer: Timer | undefined;
    let sizeToFlush = 0;
    let flushedCnt = 0;

    function shouldQueue(env: Envelope, error: Error, retryDelay: number): boolean | Promise<boolean> {
      // We don't queue Session Replay envelopes because they are:
      // - Ordered and Replay relies on the response status to know when they're successfully sent.
      // - Likely to fill the queue quickly and block other events from being sent.
      // We also want to drop client reports because they can be generated when we retry sending events while offline.
      if (envelopeContainsItemType(env, ['replay_event', 'replay_recording', 'client_report'])) {
        return false;
      }

      if (options.shouldStore) {
        return options.shouldStore(env, error, retryDelay);
      }

      return true;
    }

    function flushIn(delay: number, isFlushingHead = false): Promise<void> {
      if (!store) {
        return Promise.resolve();
      }

      if (flushTimer) {
        clearTimeout(flushTimer as ReturnType<typeof setTimeout>);
      }

      return new Promise((resolve, _reject) => {
        flushTimer = setTimeout(async () => {
          flushTimer = undefined;

          const offset = isFlushingHead ? 0 : (sizeToFlush - flushedCnt);
          const canPop = isFlushingHead ? flushedCnt < sizeToFlush : true;
          const found = canPop && await store.pop(offset);
          if (found) {
            if (isFlushingHead) {
              flushedCnt++;
            }
            log('Attempting to send previously queued event');
            try {
              await send(found, isFlushingHead);
            } catch (e) {
              // log('Failed to retry sending', e);
              console.log('!!! Failed to retry sending', e); // todo: remove
            }
          }
          if (isFlushingHead && flushedCnt === sizeToFlush) {
            // flush end
            sizeToFlush = 0;
            flushedCnt = 0;
          }
          resolve();
        }, delay) as Timer;

        // We need to unref the timer in node.js, otherwise the node process never exit.
        if (typeof flushTimer !== 'number' && flushTimer.unref) {
          flushTimer.unref();
        }
      });
    }

    async function flushWithBackOff(isFlushingHead = false): Promise<void> {
      if (flushTimer) {
        return;
      }

      await flushIn(retryDelay, isFlushingHead);
    }

    async function send(envelope: Envelope, isFlushingHead = false): Promise<void | TransportMakeRequestResponse> {
      if (store && options.fullOffline && !isFlushingHead) {
        await store.insert(envelope);
        return {};
      }

      try {
        const result = await transport.send(envelope);

        let delay = MIN_DELAY;

        if (result) {
          // If there's a retry-after header, use that as the next delay.
          if (result.headers && result.headers['retry-after']) {
            delay = parseRetryAfterHeader(result.headers['retry-after']);
          } // If we have a server error, return now so we don't flush the queue.
          else if ((result.statusCode || 0) >= 400) {
            return result;
          }
        }

        retryDelay = 0;
        if (isFlushingHead) {
          // wait
          await flushIn(delay, isFlushingHead);
        } else {
          // don't wait
          flushIn(delay);
        }
        return result;
      } catch (e) {
        retryDelay = Math.max(Math.min(retryDelay * 2, MAX_DELAY), START_DELAY);
        if (store && (await shouldQueue(envelope, e as Error, retryDelay))) {
          if (isFlushingHead) {
            // return back to the start of queue
            await store.insert(envelope, true);
            flushedCnt--;
            console.log('Error sending. Trying to resend', e as Error); //todo: log()
            await flushWithBackOff(isFlushingHead);
          } else {
            // push to the end of queue
            await store.insert(envelope);
            console.log('Error sending. Event queued', e as Error); //todo: log()
            flushWithBackOff();
          }
          return {};
        } else {
          throw e;
        }
      }
    }

    if (options.flushAtStartup) {
      flushWithBackOff();
    }

    return {
      send,
      flush: async t => {
        if (options.fullOffline) {
          if (t ?? 0 < 0) {
            // clear storage
            await store?.clear();
            return true;
          } else {
            if (sizeToFlush > 0) {
              // flushing in progress
              return false;
            } else {
              sizeToFlush = await store?.size() || 0;
              if (sizeToFlush > 0) {
                await flushWithBackOff(true);
              }
              return true;
            }
          }
        } else {
          return await transport.flush(t);
        }
      },
    };
  };
}
