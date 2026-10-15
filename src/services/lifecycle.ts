import { invalidTransition } from '../errors.js';

export type OrderStatus = 'created' | 'ready' | 'assigned' | 'accepted' | 'picked_up' | 'out_for_delivery' | 'arrived' | 'delivered' | 'partial' | 'failed' | 'full_return' | 'cancelled';
export const TERMINAL: OrderStatus[] = ['delivered', 'partial', 'failed', 'full_return', 'cancelled'];
export const OUTCOMES: OrderStatus[] = ['delivered', 'partial', 'failed', 'full_return'];

/** The ONLY legal status transitions. Everything else is rejected with INVALID_TRANSITION. */
export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  created: ['ready', 'cancelled'],
  ready: ['assigned', 'cancelled'],
  assigned: ['accepted', 'assigned', 'ready', 'cancelled'],                // assigned->assigned = reassignment, ->ready = partner rejected
  accepted: ['picked_up', 'assigned', 'cancelled'],
  picked_up: ['out_for_delivery', 'assigned', 'cancelled'],
  out_for_delivery: ['arrived', 'delivered', 'partial', 'failed', 'full_return'],
  arrived: ['delivered', 'partial', 'failed', 'full_return'],
  delivered: [], partial: [], full_return: [], cancelled: [],
  failed: ['ready', 'assigned', 'cancelled'],                                // retry / reschedule / reassign
};
export function assertTransition(from: OrderStatus, to: OrderStatus) {
  if (!TRANSITIONS[from]?.includes(to)) throw invalidTransition(`Cannot change order from "${from}" to "${to}"`);
}
