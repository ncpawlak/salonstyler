/**
 * Prompt + tool for "which column is which?". The model only sees header names and redacted
 * samples (see `redactedColumnSamples`), and its answer is sanitized before anything uses it:
 * every value is still parsed by deterministic code in `@chairside/core`.
 */
import {
  type ColumnMapping,
  type ImportKind,
  importFields,
  sanitizeColumnMapping,
} from '@chairside/core';

import type { ChatMessage, ToolCall, ToolDefinition } from '../types.ts';

export const MAPPING_TOOL = 'set_column_mapping';

export function columnMappingTool(kind: ImportKind): ToolDefinition {
  const properties: Record<string, unknown> = {};
  for (const f of importFields(kind)) {
    properties[f.key] = {
      type: 'integer',
      minimum: -1,
      description: `${f.label}: ${f.description}. Column index, or -1 if no column holds it.`,
    };
  }
  return {
    name: MAPPING_TOOL,
    description: 'Record which spreadsheet column (0-based index) holds each field.',
    parameters: { type: 'object', properties, additionalProperties: false },
  };
}

const SOURCE: Record<ImportKind, string> = {
  clients: 'a customer list exported from a salon booking system (usually Vagaro)',
  appointments: 'an appointment list exported from a salon booking system (usually Vagaro)',
};

export function columnMappingPrompt(
  kind: ImportKind,
  headers: readonly string[],
  samples: readonly (readonly string[])[],
): ChatMessage[] {
  const columns = headers
    .map((h, i) => {
      const s = (samples[i] ?? []).map((v) => JSON.stringify(v)).join(', ');
      return `${i}: ${JSON.stringify(h)}${s ? ` — e.g. ${s}` : ''}`;
    })
    .join('\n');
  return [
    {
      role: 'system',
      content: [
        `You map the columns of ${SOURCE[kind]} to Chairside fields.`,
        `Call ${MAPPING_TOOL} exactly once. Use each column for at most one field and use -1 for`,
        'fields no column holds. Sample values are masked: letters after the first of each word',
        'are "x", digits are "#". Prefer a mobile/cell number for the main phone. Map a single',
        'whole-name column to the full name; map split columns to first/last name instead.',
        'Never map an ID, address, staff/provider or "customer since" column to a client field.',
      ].join(' '),
    },
    { role: 'user', content: `Columns:\n${columns}` },
  ];
}

/** The mapping from the model's reply (tool call, or JSON in plain text as a fallback). */
export function readColumnMapping<K extends ImportKind>(
  kind: K,
  headers: readonly string[],
  result: { toolCalls: readonly ToolCall[]; text: string | null },
): ColumnMapping<K> | null {
  let raw: unknown = result.toolCalls.find((c) => c.name === MAPPING_TOOL)?.arguments;
  if (!raw && result.text) {
    const json = /\{[\s\S]*\}/.exec(result.text)?.[0];
    try {
      raw = json ? JSON.parse(json) : null;
    } catch {
      raw = null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return sanitizeColumnMapping(kind, headers, raw as Record<string, unknown>);
}
