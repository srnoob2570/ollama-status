import type { Classification } from './types.ts';

export type Entitlement = 'FREE' | 'PAID' | 'UNKNOWN';

/**
 * Derive the model entitlement tier from a free-account probe classification.
 *
 * A successful free probe means the model is accessible on the free tier.
 * A `SUBSCRIPTION_REQUIRED` response means the model requires a paid plan.
 * Any other result (error, timeout, etc.) is inconclusive and returns `UNKNOWN`.
 */
export function entitlementFromFreeProbe(classification: Classification): Entitlement {
    if (classification === 'SUCCESS' || classification === 'HIGH_LATENCY') return 'FREE';
    if (classification === 'SUBSCRIPTION_REQUIRED') return 'PAID';
    return 'UNKNOWN';
}

/**
 * Whether a paid probe should follow the free one for this classification.
 *
 * Only `SUBSCRIPTION_REQUIRED` triggers a paid follow-up, and only when
 * a paid API key is actually configured.
 */
export function shouldProbePaid(
    classification: Classification,
    paidKeyConfigured: boolean,
): boolean {
    return classification === 'SUBSCRIPTION_REQUIRED' && paidKeyConfigured;
}
