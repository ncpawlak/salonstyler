/**
 * `import-services` Edge Function logic (#16): turns a Vagaro booking-page link, pasted menu text,
 * or a menu screenshot into a list of services for the owner to review. The model only reads the
 * menu; everything it returns is sanitized here and saved later through `save_service`.
 */
import {
  type ExtractServicesResponse,
  type ExtractedService,
  looksLikeMenuText,
  parseMenuText,
} from '@chairside/core';
import { z } from 'zod';

import {
  DEMO_SCREENSHOT_MENU,
  type MenuInput,
  readExtractedServices,
  servicesExtractionPrompt,
  servicesExtractionTool,
} from '../import/services.ts';
import {
  type FetchPageOptions,
  VAGARO_PAGE_MAX_TEXT,
  fetchVagaroPage,
  parseVagaroUrl,
  vagaroPageText,
} from '../import/vagaro-page.ts';
import { createProvider as defaultCreateProvider } from '../registry.ts';
import { type AiErrorBody, type AiServiceDeps, providerFailure } from './handler.ts';

const MAX_IMAGE_BASE64_CHARS = 8 * 1024 * 1024;

export const importServicesRequestSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('url'), salonId: z.uuid(), url: z.string().trim().min(1).max(500) }),
  z.object({
    source: z.literal('text'),
    salonId: z.uuid(),
    text: z.string().trim().min(1).max(VAGARO_PAGE_MAX_TEXT),
  }),
  z.object({
    source: z.literal('image'),
    salonId: z.uuid(),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    data: z.string().min(1).max(MAX_IMAGE_BASE64_CHARS),
  }),
]);

export interface ImportServicesDeps extends AiServiceDeps {
  /** Local development only (CHAIRSIDE_AI_DEMO): no model calls. Never set in production. */
  demo?: boolean;
  fetch?: FetchPageOptions['fetch'];
}

export type ImportServicesResult =
  | { status: 200; body: ExtractServicesResponse }
  | { status: 400 | 403 | 409 | 422 | 429 | 502; body: AiErrorBody };

const fail = (
  status: Exclude<ImportServicesResult['status'], 200>,
  code: string,
  message: string,
): ImportServicesResult => ({ status, body: { error: { code, message } } });

const SCREENSHOT_HINT = 'Take a screenshot of your menu and upload it instead.';
const NO_AI_NOTICE =
  'Read line by line because AI is not set up. Check names, lengths and prices carefully.';

function found(
  services: ExtractedService[],
  source: ExtractServicesResponse['source'],
  notice?: string,
): ImportServicesResult {
  if (services.length === 0) {
    return fail(
      422,
      'no_services_found',
      `No services were found. ${SCREENSHOT_HINT} You can also paste the menu as text.`,
    );
  }
  return { status: 200, body: notice ? { services, source, notice } : { services, source } };
}

export async function handleImportServices(
  rawBody: unknown,
  deps: ImportServicesDeps,
): Promise<ImportServicesResult> {
  const parsed = importServicesRequestSchema.safeParse(rawBody);
  if (!parsed.success) return fail(400, 'invalid_request', z.prettifyError(parsed.error));
  const request = parsed.data;

  const role = await deps.getMemberRole(request.salonId);
  if (role !== 'owner') return fail(403, 'forbidden', 'Only salon owners can import services');

  let input: MenuInput;
  if (request.source === 'url') {
    const url = parseVagaroUrl(request.url);
    if (!url) {
      return fail(
        400,
        'unsupported_url',
        'That is not a Vagaro link. Paste your vagaro.com booking page address.',
      );
    }
    const page = await fetchVagaroPage(url, { fetch: deps.fetch });
    if (!page.ok) {
      return fail(502, 'page_fetch_failed', `We couldn't open that page. ${SCREENSHOT_HINT}`);
    }
    const text = vagaroPageText(page.html);
    if (!looksLikeMenuText(text)) {
      return fail(
        422,
        'page_unreadable',
        `Vagaro shows this menu only in the browser, so we can't read it from the link. ${SCREENSHOT_HINT}`,
      );
    }
    input = { kind: 'text', text };
  } else if (request.source === 'text') {
    input = { kind: 'text', text: request.text };
  } else {
    input = {
      kind: 'image',
      image: { type: 'image', mimeType: request.mimeType, data: request.data },
    };
  }

  const fallback = () =>
    input.kind === 'text' ? parseMenuText(input.text) : ([] as ExtractedService[]);

  if (deps.demo) {
    return input.kind === 'image'
      ? found(DEMO_SCREENSHOT_MENU, 'demo', 'Demo mode: sample menu, not read from your image.')
      : found(fallback(), 'parser', NO_AI_NOTICE);
  }

  const config = await deps.loadConfig(request.salonId);
  if (!config) {
    if (input.kind === 'text') return found(fallback(), 'parser', NO_AI_NOTICE);
    return fail(
      409,
      'not_configured',
      'Reading a screenshot needs AI. Add a key in Settings → AI, or paste the menu as text.',
    );
  }
  const used = await deps.tokensUsedThisMonth(request.salonId);
  if (used >= config.monthlyTokenBudget) {
    if (input.kind === 'text') {
      return found(fallback(), 'parser', 'Read line by line: the monthly AI budget is used up.');
    }
    return fail(429, 'budget_exceeded', 'This salon has used its monthly AI token budget');
  }

  const create = deps.createProvider ?? defaultCreateProvider;
  try {
    const llm = create(config.provider, { apiKey: config.apiKey, model: config.model });
    const result = await llm.chat(servicesExtractionPrompt(input), [servicesExtractionTool()], {
      maxOutputTokens: 8192,
      temperature: 0,
    });
    await deps.recordUsage({
      salonId: request.salonId,
      provider: config.provider,
      model: result.model,
      purpose: 'import_services',
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
    const services = readExtractedServices(result);
    if (services === null) {
      const parsedLines = fallback();
      if (parsedLines.length) return found(parsedLines, 'parser', NO_AI_NOTICE);
      return fail(502, 'provider_bad_response', 'The model did not return a menu. Try again.');
    }
    return found(services, 'ai');
  } catch (error) {
    const parsedLines = fallback();
    if (parsedLines.length) {
      return found(parsedLines, 'parser', 'AI was unavailable, so the menu was read line by line.');
    }
    const failure = providerFailure(error, config.apiKey);
    return { status: 502, body: failure.body as AiErrorBody };
  }
}
