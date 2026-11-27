import { z } from 'zod';

export const requestQuoteSchema = z.strictObject({
  sku: z.string().min(1).max(64),
  quantity: z.number().int().min(1).max(100),
});
export const quoteSchema = requestQuoteSchema.extend({
  totalCents: z.number().int().min(1),
  currency: z.literal('USD'),
});
export type QuoteRequest = z.infer<typeof requestQuoteSchema>;

export const issuer = 'https://issuer.example.test';
export const buyerAudience = 'urn:fevex:quote-buyer';
export const supplierAudience = 'urn:a2a:quote-supplier';
export const tenantClaim = 'https://fevex.dev/tenant';
