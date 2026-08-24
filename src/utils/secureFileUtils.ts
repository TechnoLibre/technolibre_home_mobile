import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { encryptCredential, decryptCredential } from "./cryptoUtils";

/**
 * Writes a file with AES-256-GCM encryption.
 * The base64 data is encrypted before writing to disk.
 * Filename gets an .enc extension to distinguish from plaintext files.
 */
export async function writeEncryptedFile(
  path: string,
  base64Data: string,
  directory: Directory = Directory.Data
): Promise<string> {
  const encrypted = await encryptCredential(base64Data);
  const encPath = path + ".enc";
  const result = await Filesystem.writeFile({
    path: encPath,
    data: encrypted,
    directory,
    encoding: Encoding.UTF8,
  });
  return result.uri;
}

/**
 * Reads and decrypts an AES-256-GCM encrypted file.
 * Falls back to reading as plaintext if file has no .enc extension
 * (backwards compatibility with existing unencrypted files).
 */
export async function readEncryptedFile(
  path: string,
  directory: Directory = Directory.Data
): Promise<string> {
  if (path.endsWith(".enc")) {
    const { data } = await Filesystem.readFile({
      path,
      directory,
      encoding: Encoding.UTF8,
    });
    return decryptCredential(data as string);
  }

  // Legacy unencrypted file
  const { data } = await Filesystem.readFile({ path, directory });
  if (data instanceof Blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
      reader.onerror = reject;
      reader.readAsDataURL(data);
    });
  }
  return data as string;
}
