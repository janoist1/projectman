# core/attachments

## Responsibility

Task and message attachment records, storage, validation, processing, thumbnails and deletion.

## Facade

`core/attachments/index.ts` is the only entry point. It exports `AttachmentService`, `createAttachmentStorage`, `contentDisposition`, `sanitizeFileName`, `sniffMediaType`, `MessageAttachmentService`, `createMessageAttachmentStorage` and `sessionFileName`. The inner `attachments/index.ts` and `message-attachments/index.ts` keep their storage factories as internal implementation; nothing outside the module imports them.

## Ports

`AttachmentStorage`, `MessageAttachmentStorage` and attachment operations are defined in `contracts/`. Services receive `DomainContext`, projects and, for task attachments, tasks/timeline and an optional deletion callback. Concrete local storage stays behind the existing storage ports.

## Files

Everything lives under `apps/server/src/core/attachments/`:

- `attachments/`: task attachments (`service.ts`, `storage.ts`, `files.ts`, `upload.ts`, `thumbnail.ts`, `file-name.ts`, `media-type.ts`, `index.ts`);
- `message-attachments/`: message attachments (`service.ts`, `storage.ts`, `image.ts`, `index.ts`);
- `tests/`: the module's own tests;
- `index.ts`: the facade.

The authoritative descriptor is
[`core-attachments.ts`](../../apps/server/test/architecture/modules/core-attachments.ts),
imported by the single [module map](../../apps/server/test/architecture/module-map.ts).
Its only path is `core/attachments/`, with `sealed: true`.

## Remote engine

Attachment metadata stays on the server; filesystem storage and session-folder access follow the storage/engine
contracts and the transfer flow. The attachment and message-file entries of
[MACHINE-DEPENDENT.md](../MACHINE-DEPENDENT.md) describe the machine assumptions.
