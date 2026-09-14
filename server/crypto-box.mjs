import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
export function seal(bytes, key, scope) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(scope));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
}
export function unseal(bytes, key, scope) {
  if (bytes.length < 29 || bytes[0] !== 1) throw new Error('Invalid encrypted data');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 13));
  decipher.setAAD(Buffer.from(scope)); decipher.setAuthTag(bytes.subarray(13, 29));
  return Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]);
}
