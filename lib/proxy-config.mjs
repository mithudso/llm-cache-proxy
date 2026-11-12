// Runtime settings are validated once at startup.
import { readLimits } from './proxy-validation.mjs';
export const limits = Object.freeze(readLimits(process.env));
