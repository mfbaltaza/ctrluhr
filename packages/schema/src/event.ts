import { z } from 'zod';

export const ActivityEventSchema = z.object({
  id: z.string().uuid(),
  app_name: z.string().min(1).max(200),
  window_title: z.string().min(1).max(500),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime(),
});

export const EventBatchSchema = z.object({
  events: z.array(ActivityEventSchema).max(500),
});

export type ActivityEvent = z.infer<typeof ActivityEventSchema>;
export type EventBatch = z.infer<typeof EventBatchSchema>;

export const EventReceiptSchema = z.object({
  id: z.string().uuid(),
  category_id: z.string().uuid().nullable(),
});

export type EventReceipt = z.infer<typeof EventReceiptSchema>;
