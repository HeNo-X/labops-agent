import { AsyncLocalStorage } from 'node:async_hooks';
import type { SandboxActor } from '../../shared/operations-contract.ts';

export const requestIdentity = new AsyncLocalStorage<SandboxActor>();
export function currentActor(): SandboxActor | undefined { return requestIdentity.getStore(); }
