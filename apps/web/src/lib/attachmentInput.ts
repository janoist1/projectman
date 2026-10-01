/**
 * What the attachments section takes from a drop or a paste. Only files are taken: text that is
 * dragged or pasted stays with whatever it was meant for (the description, a comment).
 */

/** A drag carries files (and not just text or a link). */
export function dragHasFiles(data: DataTransfer | null): boolean {
  return Boolean(data && Array.from(data.types ?? []).includes('Files'));
}

/** The files of a drop; a dropped folder is not a file and is left out. */
export function droppedFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []);
  const entries = Array.from(data.items ?? []);
  if (entries.length !== files.length) return files;
  return files.filter((_file, index) => {
    const entry = entries[index];
    return !(entry && typeof entry.webkitGetAsEntry === 'function' && entry.webkitGetAsEntry()?.isDirectory);
  });
}

/** The images of a paste. A pasted file that is not an image is not taken. */
export function pastedImages(data: DataTransfer | null): File[] {
  return Array.from(data?.files ?? []).filter((file) => file.type.startsWith('image/'));
}

/** Whether the paste also carries text: then the paste is the text's (a page copied with its pictures). */
export function pasteHasText(data: DataTransfer | null): boolean {
  return typeof data?.getData === 'function' && data.getData('text/plain').trim() !== '';
}

/** A field where the person is typing: a text input, a text area or editable content. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest('[contenteditable]:not([contenteditable="false"])') !== null ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement
  );
}
