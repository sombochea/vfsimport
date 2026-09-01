import { tmpdir } from "os";
import { join } from "path";
import { unlink } from "fs/promises";
import { randomUUID } from "crypto";
import { detectMimeFromBuffer, parseDataUri, getExtensionFromMime } from "./mime";
import type { CliOptions, CsvRow, UploadResult } from "./types";

/**
 * Uploads a single decoded row to the VFS server.
 */
export async function uploadRow(
  row: CsvRow,
  options: CliOptions
): Promise<UploadResult> {
  const startTime = Date.now();
  let tempFilePath: string | null = null;

  try {
    if (!row.data || row.data.trim() === "") {
      return {
        key: row.key,
        success: false,
        error: "Missing or empty base64 data",
        durationMs: Date.now() - startTime,
      };
    }

    // 1. Parse Data URI if present
    const { mime: uriMime, rawBase64 } = parseDataUri(row.data);

    // 2. Decode base64 to Buffer
    const buffer = Buffer.from(rawBase64, "base64");
    if (buffer.length === 0) {
      return {
        key: row.key,
        success: false,
        error: "Decoded base64 buffer is empty",
        durationMs: Date.now() - startTime,
      };
    }

    // 3. Determine MIME type and file extension
    const detected = detectMimeFromBuffer(buffer);
    const resolvedMime =
      row.mimeType ||
      uriMime ||
      (detected ? detected.mime : undefined) ||
      options.mimeType ||
      "application/octet-stream";

    const resolvedExt =
      (detected ? detected.ext : undefined) ||
      getExtensionFromMime(resolvedMime);

    // 4. Determine file name
    const sanitizedKey = row.key.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = row.name
      ? row.name
      : sanitizedKey.includes(".")
      ? sanitizedKey
      : `${sanitizedKey}.${resolvedExt}`;

    // 5. Write to temporary file
    const targetTmpDir = options.tmpDir || tmpdir();
    const tempFileName = `vfs_${Date.now()}_${randomUUID().slice(0, 8)}_${filename}`;
    tempFilePath = join(targetTmpDir, tempFileName);

    await Bun.write(tempFilePath, buffer);

    // 6. Build FormData
    const formData = new FormData();
    const bunFile = Bun.file(tempFilePath, { type: resolvedMime });
    formData.append("file", bunFile, filename);

    // Compute SHA-256 file hash
    const fileHash = new Bun.CryptoHasher("sha256").update(buffer).digest("hex");
    formData.append("file_hash", fileHash);

    if (row.name || filename) {
      formData.append("name", row.name || filename);
    }

    if (options.bucketId) {
      formData.append("bucket_id", options.bucketId);
    }

    const metadataVal = row.metadata || options.metadata;
    if (metadataVal) {
      formData.append("metadata", metadataVal);
    }

    if (options.store) {
      formData.append("store", options.store);
    }

    // 7. Prepare Headers (only set if provided)
    const headers: Record<string, string> = {};
    if (options.apiKey) {
      headers["x-api-key"] = options.apiKey;
    }
    if (options.apiHash) {
      headers["x-api-hash"] = options.apiHash;
    }

    // 8. Execute HTTP Request
    const response = await fetch(options.url, {
      method: "POST",
      headers,
      body: formData,
    });

    const durationMs = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      return {
        key: row.key,
        success: false,
        error: `HTTP ${response.status} ${response.statusText}: ${errorText.slice(0, 500)}`,
        durationMs,
      };
    }

    // 9. Parse response
    let responseData: any;
    const responseText = await response.text();
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    // Extract URL or identifier from standard VFS response formats
    let extractedUrl: string | undefined;
    let fileId: string | undefined;

    if (typeof responseData === "object" && responseData !== null) {
      extractedUrl =
        responseData.url ||
        responseData.data?.url ||
        responseData.data?.link ||
        responseData.data?.path ||
        responseData.result?.url ||
        responseData.file?.url;

      fileId =
        responseData.id ||
        responseData.data?.id ||
        responseData.data?.file_id ||
        responseData.file_id;
    } else if (typeof responseData === "string" && responseData.startsWith("http")) {
      extractedUrl = responseData.trim();
    }

    return {
      key: row.key,
      success: true,
      url: extractedUrl || (typeof responseData === "string" ? responseData : undefined),
      fileId,
      rawResponse: responseData,
      durationMs,
    };
  } catch (err: any) {
    return {
      key: row.key,
      success: false,
      error: err.message || String(err),
      durationMs: Date.now() - startTime,
    };
  } finally {
    // 10. Clean up temporary file
    if (options.cleanTmp && tempFilePath) {
      try {
        await unlink(tempFilePath);
      } catch {
        // ignore unlink error
      }
    }
  }
}
