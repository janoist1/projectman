# core/attachments

## Responsibility

Task and message attachment records, storage, validation, processing, thumbnails and deletion.

## Facade

`domain/attachments/index.ts` exports `AttachmentService`, storage creation and file/media helpers. `domain/message-attachments/index.ts` exports `MessageAttachmentService`, storage creation and `sessionFileName`. The planned entry point is `core/attachments/index.ts`; existing storage facades remain unchanged here.

## Ports

`AttachmentStorage`, `MessageAttachmentStorage` and attachment operations are defined in `contracts/`. Services receive `DomainContext`, projects and, for task attachments, tasks/timeline and an optional deletion callback. Concrete local storage stays behind the existing storage ports.

## Current and planned files

Current paths under `apps/server/src`: `domain/attachments/`, `domain/message-attachments/`.
The planned folder is `apps/server/src/core/attachments/`.
The authoritative descriptor is
[`core-attachments.ts`](../../apps/server/test/architecture/modules/core-attachments.ts),
imported by the single [module map](../../apps/server/test/architecture/module-map.ts).
Its paths, pass, layer and sealed state are preserved by PM-631; later module slices
update only their own descriptor and this document. They do not edit the central map,
architecture table or other modules' importers.

## Remote engine

Attachment metadata stays on the server; filesystem storage and session-folder access follow the existing storage/engine contracts and transfer flow. The attachment and message-file inventory entries describe the machine assumptions. This preparation introduces no new filesystem operation, RPC or transfer payload.

PM-631 only prepares file ownership for parallel refactor slices. It changes no
shared contract, database schema, configuration or timeline event.
