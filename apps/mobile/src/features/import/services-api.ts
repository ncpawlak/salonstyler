import {
  parseMenuText,
  serviceImportPayload,
  servicesToArchive,
  type ExtractServicesRequest,
  type ExtractServicesResponse,
  type ServiceImportRow,
} from '@chairside/core';
import type { ChairsideClient } from '@chairside/db';
import { saveService, setServiceArchived, type ServiceMenu } from '@chairside/db/services';

import { AiRequestError } from '../ai-settings/api';

async function readError(error: unknown): Promise<AiRequestError> {
  const context = (error as { context?: unknown }).context;
  if (context instanceof Response) {
    try {
      const body = (await context.json()) as { error?: { code: string; message: string } };
      if (body.error) return new AiRequestError(body.error.code, body.error.message);
    } catch {
      // fall through
    }
  }
  return new AiRequestError('network', error instanceof Error ? error.message : String(error));
}

/**
 * Reads a menu with the `import-services` Edge Function (the link is fetched server-side). Pasted
 * text is still read line by line on this device if the function can't be reached.
 */
export async function extractServices(
  supabase: ChairsideClient,
  request: ExtractServicesRequest,
): Promise<ExtractServicesResponse> {
  const { data, error } = await supabase.functions.invoke<ExtractServicesResponse>(
    'import-services',
    { body: request },
  );
  if (error || !data) {
    const failure = error
      ? await readError(error)
      : new AiRequestError('invalid_response', 'Empty response from the import service');
    if (request.source === 'text' && failure.code === 'network') {
      const services = parseMenuText(request.text);
      if (services.length) {
        return {
          services,
          source: 'parser',
          notice: 'Read line by line on this device. Check names, lengths and prices carefully.',
        };
      }
    }
    throw failure;
  }
  return data;
}

export type ServiceImportMode = 'merge' | 'replace';

export interface ServiceImportOutcome {
  added: number;
  updated: number;
  skipped: number;
  archived: number;
  failed: { name: string; message: string }[];
}

/**
 * Saves the reviewed rows one by one through `save_service` (so every row gets the same
 * validation as the Services editor), then, in replace mode, archives what the import didn't keep.
 * Nothing is archived if any row failed.
 */
export async function runServiceImport(
  supabase: ChairsideClient,
  salonId: string,
  rows: readonly ServiceImportRow[],
  menu: ServiceMenu,
  mode: ServiceImportMode,
  onProgress?: (done: number, total: number) => void,
): Promise<ServiceImportOutcome> {
  const outcome: ServiceImportOutcome = {
    added: 0,
    updated: 0,
    skipped: 0,
    archived: 0,
    failed: [],
  };
  const byId = new Map(menu.services.map((s) => [s.id, s]));
  const todo = rows.filter((r) => r.action !== 'skip');
  outcome.skipped = rows.length - todo.length;
  let done = 0;
  onProgress?.(done, todo.length);
  for (const row of todo) {
    try {
      const existing = row.match ? byId.get(row.match.id) : undefined;
      await saveService(supabase, salonId, serviceImportPayload(row, existing));
      if (row.action === 'add') outcome.added++;
      else outcome.updated++;
    } catch (e) {
      const message = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
      outcome.failed.push({ name: row.name, message });
    }
    onProgress?.(++done, todo.length);
  }
  if (mode === 'replace' && outcome.failed.length === 0) {
    for (const id of servicesToArchive(rows, menu)) {
      await setServiceArchived(supabase, id, true);
      outcome.archived++;
    }
  }
  return outcome;
}
