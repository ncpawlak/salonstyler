const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Rewrites every uuid in `text` through `ids` (old id → new id), like
 * `private.data_export_remap_text` does for the rows. Used to move photos to their restored paths.
 */
export function remapUuids(text: string, ids: Record<string, string>): string {
  return text.replace(UUID, (id) => ids[id.toLowerCase()] ?? id);
}
