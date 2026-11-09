import type { ReactNode } from 'react';

import { testReader, type CardReader } from './reader';

/** Web (and the default platform): no NFC, so card payments use Stripe's simulated reader. */
export function CardReaderProvider({ children }: { salonId: string; children: ReactNode }) {
  return children;
}

export function useCardReader(): CardReader {
  return testReader;
}
