# workers — worker entry points

- `import.worker.ts` — the MusicXML import worker (spec "Execution and rendering architecture":
  expand, validate and normalize scores in a dedicated worker). It only binds
  `core/import/workerHandler.ts` to the worker global; the message protocol is
  `core/import/protocol.ts` and the main-thread side is `createImportClient()` in
  `core/import/client.ts`, which creates this worker with
  `new Worker(new URL('../../workers/import.worker.ts', import.meta.url), { type: 'module' })`.

Jobs are stateless: each request carries a transferred copy of the file bytes, results never
include the file, and the client terminates the worker after a build or on cancellation so its
memory is returned. Typechecked by `tsconfig.worker.json` (WebWorker libs only).
