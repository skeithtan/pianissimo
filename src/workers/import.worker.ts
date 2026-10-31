/**
 * Import worker entry (spec: expand, validate and normalize MusicXML in a dedicated worker).
 * All logic lives in `core/import/workerHandler.ts`; this file only binds it to the worker global.
 */
import { createImportWorkerHandler } from '../core/import/workerHandler'
import type { ImportWorkerRequest } from '../core/import/protocol'

declare const self: DedicatedWorkerGlobalScope

const handle = createImportWorkerHandler((message) => self.postMessage(message))

self.onmessage = (event: MessageEvent<ImportWorkerRequest>) => {
  void handle(event.data)
}
