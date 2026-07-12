import type { Classification } from './types.ts';

export type Entitlement = 'FREE' | 'PAID' | 'UNKNOWN';

export function entitlementFromFreeProbe(classification: Classification): Entitlement {
    if (classification === 'SUCCESS' || classification === 'HIGH_LATENCY') return 'FREE';
    if (classification === 'SUBSCRIPTION_REQUIRED') return 'PAID';
    return 'UNKNOWN';
}

export function shouldProbePaid(
    classification: Classification,
    paidKeyConfigured: boolean,
): boolean {
    return classification === 'SUBSCRIPTION_REQUIRED' && paidKeyConfigured;
}
