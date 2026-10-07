import { AsyncLocalStorage } from 'node:async_hooks';
import type { SandboxActor } from '../../shared/operations-contract.ts';

export const requestIdentity = new AsyncLocalStorage<SandboxActor>();
export function currentActor(): SandboxActor | undefined { return requestIdentity.getStore(); }
export interface NativeDelegation {token:string;profile:{username:string;identity:'admin'|'volunteer'|'student';className?:string;name?:string};sharedChat?:boolean;channel?:'full_labops'|'main_shared_chat'}
export const nativeDelegation = new AsyncLocalStorage<NativeDelegation>();
export const requestTrace = new AsyncLocalStorage<string>();
