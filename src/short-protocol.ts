/** Numbers and shapes the short-link Worker and its client agree on. */

/** Most base64url characters of ciphertext a short link may hold. */
export const MAX_CIPHERTEXT_CHARS = 16_384;
/** AES-GCM tag (16 bytes) is the smallest ciphertext: 22 base64url characters. */
export const MIN_CIPHERTEXT_CHARS = 22;
export const IV_CHARS = 16;
export const KEY_CHARS = 43;
/** Most plaintext bytes that fit under the ciphertext cap. */
export const MAX_PLAINTEXT_BYTES = Math.floor((MAX_CIPHERTEXT_CHARS * 3) / 4) - 16;
/** Seconds a short link may live: an hour, a day, a week, a month. */
export const TTLS = [3600, 86_400, 604_800, 2_592_000] as const;
export const DEFAULT_TTL = 604_800;
export const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export const ID_LENGTH = 10;
export const ID_PATTERN = /^[a-km-np-z2-9]{10}$/;
export const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
export const MAX_BODY_BYTES = MAX_CIPHERTEXT_CHARS + 256;
export const DEFAULT_DAILY_LIMIT = 100;
