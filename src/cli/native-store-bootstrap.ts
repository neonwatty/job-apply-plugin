import { JobsError } from '../contracts/workspace/values.js';
import type { Value } from '../contracts/workspace/values.js';
import type { NativeStoreBootstrap } from '../store/native-store-bootstrap.js';

export const nativeStoreBootstrapCommands: Record<string, string[]> = { init: [], paths: [] };
export function runNativeStoreBootstrapCommand(command: string, service: NativeStoreBootstrap): Promise<Value> | Value {
  if (command === 'paths') return service.paths();
  if (command === 'init') return service.initialize();
  throw new JobsError('unsupported native Store bootstrap command');
}
