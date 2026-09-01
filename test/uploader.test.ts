import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { uploadRow } from "../src/uploader";
import { runWorkerPool } from "../src/pool";
import { parseCsvStream } from "../src/csv";
import { unlink } from "fs/promises";
import type { CliOptions } from "../src/types";

describe("Uploader & Integration", () => {
  const originalFetch = globalThis.fetch;
  const receivedRequests: any[] = [];
  const testCsvPath = "/tmp/integration_test.csv";
  const testOutputPath = "/tmp/integration_output.json";
  const serverUrl = "https://vfs-server-dev-devx1.ctdn.dev/api/upload";

  beforeEach(() => {
    receivedRequests.length = 0;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = new Headers(init?.headers);
      const formData = init?.body as FormData;

      const apiKey = headers.get("x-api-key");
      const apiHash = headers.get("x-api-hash");
      const file = formData.get("file") as File;
      const fileHash = formData.get("file_hash") as string;
      const bucketId = formData.get("bucket_id") as string;
      const name = formData.get("name") as string;
      const metadata = formData.get("metadata") as string;
      const store = formData.get("store") as string;

      const fileContent = file ? await file.text() : "";

      receivedRequests.push({
        url,
        apiKey,
        apiHash,
        bucketId,
        name,
        metadata,
        store,
        fileHash,
        fileName: name,
        fileContent,
      });

      return new Response(
        JSON.stringify({
          success: true,
          data: {
            id: "file_12345",
            url: `https://vfs.example.com/uploads/${bucketId || "demo"}/${name}`,
          },
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }
      );
    };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    try {
      await unlink(testCsvPath);
      await unlink(testOutputPath);
    } catch {}
  });

  test("uploads single row with correct headers and form fields", async () => {
    const base64Data = Buffer.from("hello world test content").toString("base64");
    const options: CliOptions = {
      input: "",
      output: "/tmp/out.json",
      outputFormat: "json",
      outputKeyHeader: "key",
      outputUrlHeader: "url",
      onlyCols: false,
      includeStatus: true,
      url: serverUrl,
      apiKey: "test-api-key-123",
      bucketId: "custom_bucket",
      metadata: JSON.stringify({ source: "unit_test" }),
      store: "local",
      mimeType: "text/plain",
      concurrency: 1,
      chunkSize: 10,
      cleanTmp: true,
    };

    const result = await uploadRow(
      {
        rowIndex: 1,
        key: "test_key",
        data: base64Data,
      },
      options
    );

    expect(result.success).toBe(true);
    expect(result.url).toBe("https://vfs.example.com/uploads/custom_bucket/test_key.txt");
    expect(receivedRequests.length).toBe(1);

    const req = receivedRequests[0];
    expect(req.apiKey).toBe("test-api-key-123");
    expect(req.bucketId).toBe("custom_bucket");
    expect(req.metadata).toBe(JSON.stringify({ source: "unit_test" }));
    expect(req.store).toBe("local");
    expect(req.fileContent).toBe("hello world test content");
    expect(req.fileHash).toBe(
      new Bun.CryptoHasher("sha256")
        .update(Buffer.from("hello world test content"))
        .digest("hex")
    );
  });

  test("does not send auth headers when apiKey/apiHash are undefined", async () => {
    const base64Data = Buffer.from("no auth").toString("base64");
    const options: CliOptions = {
      input: "",
      output: "/tmp/out.json",
      outputFormat: "json",
      outputKeyHeader: "key",
      outputUrlHeader: "url",
      onlyCols: false,
      includeStatus: true,
      url: serverUrl,
      concurrency: 1,
      chunkSize: 10,
      cleanTmp: true,
    };

    const result = await uploadRow(
      {
        rowIndex: 1,
        key: "no_auth_key",
        data: base64Data,
      },
      options
    );

    expect(result.success).toBe(true);
    expect(receivedRequests.length).toBe(1);
    expect(receivedRequests[0].apiKey).toBeNull();
    expect(receivedRequests[0].apiHash).toBeNull();
    expect(receivedRequests[0].store).toBeNull();
  });

  test("uses fallback MIME type when specified", async () => {
    const rawBase64 = Buffer.from("custom binary data").toString("base64");
    const options: CliOptions = {
      input: "",
      output: "/tmp/out.json",
      outputFormat: "json",
      outputKeyHeader: "key",
      outputUrlHeader: "url",
      onlyCols: false,
      includeStatus: true,
      url: serverUrl,
      mimeType: "application/pdf",
      concurrency: 1,
      chunkSize: 10,
      cleanTmp: true,
    };

    const result = await uploadRow(
      {
        rowIndex: 1,
        key: "doc_1",
        data: rawBase64,
      },
      options
    );

    expect(result.success).toBe(true);
    expect(receivedRequests[0].fileName).toBe("doc_1.pdf");
  });

  test("runs full integration batch upload via worker pool", async () => {
    // 1x1 PNG transparent pixel base64
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    const csvContent = `key,data\npic1,${pngBase64}\npic2,${pngBase64}\npic3,${pngBase64}`;
    await Bun.write(testCsvPath, csvContent);

    const options: CliOptions = {
      input: testCsvPath,
      output: testOutputPath,
      outputFormat: "json",
      outputKeyHeader: "key",
      outputUrlHeader: "url",
      onlyCols: false,
      includeStatus: true,
      url: serverUrl,
      apiHash: "hash-secret-999",
      bucketId: "demo",
      concurrency: 2,
      chunkSize: 10,
      cleanTmp: true,
    };

    const rowStream = parseCsvStream(testCsvPath);
    const summary = await runWorkerPool(rowStream, options);

    expect(summary.total).toBe(3);
    expect(summary.succeeded).toBe(3);
    expect(summary.failed).toBe(0);

    // Read and verify JSON output file
    const outputFile = Bun.file(testOutputPath);
    const outputData = await outputFile.json();

    expect(outputData.items.length).toBe(3);
    const keys = outputData.items.map((i: any) => i.key).sort();
    expect(keys).toEqual(["pic1", "pic2", "pic3"]);
    expect(outputData.items.every((i: any) => i.success === true)).toBe(true);
    expect(outputData.summary.succeeded).toBe(3);
  });
});
