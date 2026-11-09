export {
  formatPhone,
  inboxDedupeKey,
  isPhoneLike,
  normalizePhone,
  phonesMatch,
  sha256Hex,
  stripKeyword,
} from './text.ts';
export {
  demoParse,
  inboxParsePrompt,
  normalizeParsed,
  parseWithLlm,
  SUBMIT_REQUEST_TOOL,
  type InboxIntent,
  type InboxParseContext,
  type ParsedInboxRequest,
} from './parse.ts';
export {
  formatSlotLabel,
  handleInboxRequest,
  INBOX_HOURLY_LIMIT,
  INBOX_NOTE,
  inboxRequestSchema,
  matchClient,
  type CaptureInput,
  type CaptureResult,
  type InboxBridge,
  type InboxPort,
  type InboxRequest,
  type InboxResponse,
  type InboxServiceDeps,
  type InboxServiceResult,
} from './handler.ts';
export {
  authenticateBridgeToken,
  createSupabaseInboxPort,
  markBridgeTested,
} from './supabase-port.ts';
export * from './shortcut.ts';
