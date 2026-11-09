import {InstanceLifecycle, type InstanceLifecycleOptions} from '../src/daemon/instance-lifecycle.js';
import type {Store} from '../src/source/store.js';

/** Watch tests supply the same invalidation, debounce, and repair owner as the
 * daemon. Closing the returned owner also closes its Store and pending work. */
export function sourceLifecycleFixture(store: Store, options: InstanceLifecycleOptions = {}): InstanceLifecycle {
  const owner = new InstanceLifecycle({reconciliationIntervalMs: 0, ...options});
  owner.register(store);
  return owner;
}
