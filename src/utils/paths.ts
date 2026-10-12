// SnClipper/src/utils/paths.ts
// Shared file-path helpers used by both the background handler (index.js) and the UI
// (App.tsx), so the derivation logic stays in one place.

// Document formats the reader renders (as opposed to editable .note files).
export const DOC_EXTENSIONS = ['.pdf', '.epub', '.txt', '.cbz', '.fb2'];

// Image formats the Supernote can open/view. Used by the Switch-Document browser and the
// switch's open path; kept SEPARATE from DOC_EXTENSIONS so isDocFile()'s crop/screenshot
// behaviour is unchanged.
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'];

// Everything the Switch-Document feature can open and switch between.
export const OPENABLE_EXTENSIONS = [...DOC_EXTENSIONS, ...IMAGE_EXTENSIONS, '.note', '.not'];

const extOf = (filePath: string): string => filePath.substring(filePath.lastIndexOf('.')).toLowerCase();

export const isImageFile = (filePath?: string | null): boolean => {
  if (!filePath) return false;
  return IMAGE_EXTENSIONS.includes(extOf(filePath));
};

// True when the Switch-Document feature should list/allow opening this path.
export const isOpenableFile = (filePath?: string | null): boolean => {
  if (!filePath) return false;
  return OPENABLE_EXTENSIONS.includes(extOf(filePath));
};

// Derive a human-readable document title from an absolute file path.
export const deriveArticleName = (filePath?: string | null): string => {
  if (!filePath) return 'Unknown Document';
  return filePath.substring(filePath.lastIndexOf('/') + 1) || 'Unknown Document';
};

// True when the path points at a rendered document (PDF/EPUB/…) rather than a note.
export const isDocFile = (filePath?: string | null): boolean => {
  if (!filePath) return false;
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  return DOC_EXTENSIONS.includes(ext);
};

// True when the path points at an editable note file (.note, .not, or extensionless note).
export const isNoteFile = (filePath?: string | null): boolean => {
  if (!filePath) return false;
  return !isDocFile(filePath);
};
