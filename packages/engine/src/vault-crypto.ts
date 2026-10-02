import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { canonicalEncode } from "./surrogate.js";
import type { VaultEntry, VaultEntryMetadata, VaultLayer, VaultLiteralEntry } from "./vault-store.js";

/**
 * Encryption at rest for persistent vault stores, shared by every backend.
 *
 * - AES-256-GCM, a random 12-byte IV per entry, and a 16-byte tag appended to the ciphertext.
 * - The additional authenticated data is a canonical (length-prefixed) encoding of the format
 *   version, scope key, layer, and token, so a ciphertext only opens in the row it was written for:
 *   swapping ciphertexts between rows, scopes, or tokens fails authentication.
 * - The raw value and everything derived from it (match flags, detection labels, entity id) are
 *   inside the ciphertext. The token, layer, scope key, and timestamps stay in clear: tokens are what
 *   already leaves the machine, and the store needs them to look entries up.
 * - `forget(value)` finds rows by a keyed lookup hash, HMAC-SHA256 under a lookup key derived from
 *   the encryption key (never the surrogate key), so the store holds no plaintext value to search.
 *   It is scope-independent, like literal surrogate tokens themselves, so it reveals nothing a token
 *   does not.
 * - Plaintext is padded to a multiple of 64 bytes, so a ciphertext's length only roughly bounds the
 *   value's length.
 *
 * The encryption key is a caller-supplied 32-byte secret, separate from the surrogate key. Both
 * subkeys come from it via HKDF-SHA256 with distinct labels.
 */

/** Current entry format; bound into each entry's authenticated data. */
export const VAULT_ENTRY_VERSION = 1;

/** A 32-byte key: raw bytes, 64 hex characters, or base64/base64url of 32 bytes. */
export type VaultEncryptionKey = string | Uint8Array;

/** The encryption key is missing or not 32 bytes in a recognised encoding. Never echoes the key. */
export class InvalidVaultKeyError extends Error {
  constructor(detail: string) {
    super(
      `vault encryption key is invalid: ${detail}. Pass 32 random bytes as a Uint8Array, 64 hex characters, ` +
        "or base64 (e.g. the output of `openssl rand -base64 32`), and keep it separate from the surrogate key",
    );
    this.name = "InvalidVaultKeyError";
  }
}

/** An entry failed to decrypt: the encryption key is wrong, or the row was altered or moved. */
export class VaultDecryptError extends Error {
  constructor() {
    super("vault entry failed authentication: wrong encryption key, or the stored row was altered or moved");
    this.name = "VaultDecryptError";
  }
}

/** An entry as a backend stores it: clear lookup columns plus the sealed payload. */
export interface SealedVaultEntry {
  readonly layer: VaultLayer;
  readonly token: string;
  readonly version: number;
  /** HMAC of the raw value under the lookup key; what `forget(value)` matches on. */
  readonly valueLookup: Uint8Array;
  readonly iv: Uint8Array;
  /** AES-256-GCM ciphertext with the 16-byte tag appended. */
  readonly ciphertext: Uint8Array;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
const PAD_TO = 64;
const KEY_CHECK_SCOPE = "\u0000ficta.vault.key-check";
const KEY_CHECK_TOKEN = "key-check";

export class VaultCipher {
  private readonly encryptionKey: Buffer;
  private readonly lookupKey: Buffer;

  constructor(key: VaultEncryptionKey) {
    const master = parseVaultKey(key);
    this.encryptionKey = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "ficta.vault.encrypt.v1", 32));
    this.lookupKey = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "ficta.vault.lookup.v1", 32));
  }

  /** Keyed lookup hash of a raw value (for `forget`). */
  valueLookup(value: string): Buffer {
    return createHmac("sha256", this.lookupKey).update(value, "utf8").digest();
  }

  seal(scope: string, entry: VaultEntry): SealedVaultEntry {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(aad(scope, entry.layer, entry.token, VAULT_ENTRY_VERSION));
    const ciphertext = Buffer.concat([cipher.update(pad(encodePayload(entry))), cipher.final(), cipher.getAuthTag()]);
    return {
      layer: entry.layer,
      token: entry.token,
      version: VAULT_ENTRY_VERSION,
      valueLookup: this.valueLookup(entry.value),
      iv,
      ciphertext,
    };
  }

  /** Decrypt one stored row. Throws {@link VaultDecryptError} if it does not authenticate in place. */
  open(scope: string, row: SealedVaultEntry): VaultEntry {
    const plaintext = this.decrypt(aad(scope, row.layer, row.token, row.version), row.iv, row.ciphertext);
    return decodePayload(row.layer, row.token, plaintext);
  }

  /** A sealed constant a backend stores once, so a wrong key fails at open rather than mid-request. */
  keyCheck(): { iv: Uint8Array; ciphertext: Uint8Array } {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(aad(KEY_CHECK_SCOPE, "detected", KEY_CHECK_TOKEN, VAULT_ENTRY_VERSION));
    const ciphertext = Buffer.concat([cipher.update(KEY_CHECK_TOKEN, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return { iv, ciphertext };
  }

  /** True when `check` (from {@link keyCheck}) was sealed under this key. */
  verifyKeyCheck(check: { iv: Uint8Array; ciphertext: Uint8Array }): boolean {
    try {
      const plain = this.decrypt(
        aad(KEY_CHECK_SCOPE, "detected", KEY_CHECK_TOKEN, VAULT_ENTRY_VERSION),
        check.iv,
        check.ciphertext,
      );
      return plain.toString("utf8") === KEY_CHECK_TOKEN;
    } catch {
      return false;
    }
  }

  private decrypt(additional: Uint8Array, iv: Uint8Array, sealed: Uint8Array): Buffer {
    if (iv.length !== IV_BYTES || sealed.length < TAG_BYTES) throw new VaultDecryptError();
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, iv);
      decipher.setAAD(additional);
      decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
      return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]);
    } catch {
      throw new VaultDecryptError();
    }
  }
}

/** Decode and validate a vault encryption key to its 32 raw bytes. */
export function parseVaultKey(key: VaultEncryptionKey): Buffer {
  if (key instanceof Uint8Array) {
    if (key.length !== 32) throw new InvalidVaultKeyError(`expected 32 bytes, got ${key.length}`);
    return Buffer.from(key);
  }
  if (typeof key !== "string" || key.length === 0) throw new InvalidVaultKeyError("no key was given");
  const text = key.trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, "hex");
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) {
    const bytes = Buffer.from(text.replaceAll("-", "+").replaceAll("_", "/"), "base64");
    if (bytes.length === 32) return bytes;
  }
  throw new InvalidVaultKeyError("expected 32 bytes encoded as 64 hex characters or base64");
}

function aad(scope: string, layer: VaultLayer, token: string, version: number): Uint8Array {
  return canonicalEncode("ficta.vault.entry", String(version), scope, layer, token);
}

function pad(plaintext: Buffer): Buffer {
  const length = Math.ceil((plaintext.length + 1) / PAD_TO) * PAD_TO;
  return Buffer.concat([plaintext, Buffer.alloc(length - plaintext.length, 0x20)]);
}

// Compact payload: one JSON object per entry. JSON.parse ignores the trailing space padding.
interface Payload {
  t: "l" | "e";
  v: string;
  h?: { name?: string; kind?: string };
  m?: 1;
  w?: 1;
  o?: 1;
  md?: unknown;
  id?: string;
  et?: string;
  tag?: string;
}

function encodePayload(entry: VaultEntry): Buffer {
  const payload: Payload = { t: entry.type === "literal" ? "l" : "e", v: entry.value };
  if (entry.type === "literal") {
    payload.h = entry.hint;
    if (entry.matchForm) payload.m = 1;
    if (entry.wordBounded) payload.w = 1;
    if (entry.tokenOnly) payload.o = 1;
    if (entry.metadata) payload.md = entry.metadata;
  } else {
    payload.id = entry.entityId;
    payload.et = entry.entityType;
    payload.tag = entry.entityTag;
  }
  return Buffer.from(JSON.stringify(payload), "utf8");
}

function decodePayload(layer: VaultLayer, token: string, plaintext: Buffer): VaultEntry {
  let payload: Payload;
  try {
    payload = JSON.parse(plaintext.toString("utf8")) as Payload;
  } catch {
    throw new VaultDecryptError();
  }
  if (typeof payload?.v !== "string") throw new VaultDecryptError();
  if (payload.t === "e") {
    if (typeof payload.id !== "string" || typeof payload.tag !== "string") throw new VaultDecryptError();
    if (payload.et !== "organization" && payload.et !== "person") throw new VaultDecryptError();
    return {
      type: "entity",
      layer,
      token,
      value: payload.v,
      entityId: payload.id,
      entityType: payload.et,
      entityTag: payload.tag,
    };
  }
  const literal: VaultLiteralEntry = {
    type: "literal",
    layer,
    token,
    value: payload.v,
    hint: (payload.h ?? {}) as VaultLiteralEntry["hint"],
    matchForm: payload.m === 1,
    wordBounded: payload.w === 1,
    tokenOnly: payload.o === 1,
  };
  return payload.md === undefined ? literal : { ...literal, metadata: payload.md as VaultEntryMetadata };
}
